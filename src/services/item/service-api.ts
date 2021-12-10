import { FastifyPluginAsync } from 'fastify';
import { IdParam, Item } from 'graasp';
import thumbnailsPlugin, { buildFilePathWithPrefix, THUMBNAIL_MIMETYPE } from 'graasp-plugin-thumbnails';
import {
  GraaspLocalFileItemOptions,
  GraaspS3FileItemOptions,
  FileItemExtra,
} from 'graasp-plugin-file';
import fileItemPlugin, { getFileExtra } from 'graasp-plugin-file-item';
import { PublicCategoriesPlugin } from 'graasp-plugin-categories';

// local
import { PublicItemService } from './db-service';
import { getOne, getChildren, getItemsBy, copyOne } from './schemas';
import { GetPublicItemTask } from './tasks/get-public-item-task';
import { GetPublicItemIdsWithTagTask } from './tasks/get-public-item-ids-by-tag-task';
import { GraaspPublicPluginOptions } from '../../service-api';
import { MergeItemMembershipsIntoItems } from './tasks/merge-item-memberships-into-item-task';
import { CannotEditPublicItem } from '../../util/errors';
import { GetItemsByCategoryTask } from './tasks/get-public-items-by-category-task';
import { GetItemCategoriesTask } from './tasks/get-public-item-categories-task';

const THUMBNAIL_ROUTE = '/thumbnails';

declare module 'fastify' {
  interface FastifyInstance {
    s3FileItemPluginOptions?: GraaspS3FileItemOptions;
    fileItemPluginOptions?: GraaspLocalFileItemOptions;
  }
}

const plugin: FastifyPluginAsync<GraaspPublicPluginOptions> = async (fastify, options) => {
  const { tagId, graaspActor, serviceMethod, prefixes: { filesPrefix, thumbnailsPrefix }, publishedTagId } = options;

  const {
    items: { dbService: iS, taskManager: iTM },
    taskRunner: runner,
    itemMemberships: { dbService: iMS },
    db,
  } = fastify;

  const pIS = new PublicItemService(tagId);

  fastify.register(thumbnailsPlugin, {
    serviceMethod: serviceMethod,
    serviceOptions: {
      s3: fastify.s3FileItemPluginOptions,
      local: fastify.fileItemPluginOptions,
    },

    pathPrefix: thumbnailsPrefix,

    uploadPreHookTasks: async (id) => {
      throw new CannotEditPublicItem(id);
    },
    downloadPreHookTasks: async ({ itemId: id, filename }) => {
      const task = new GetPublicItemTask(graaspActor, id, pIS, iS);
      task.getResult = () => ({
        filepath: buildFilePathWithPrefix({ itemId: (task.result as Item).id, pathPrefix: thumbnailsPrefix, filename }),
        mimetype: THUMBNAIL_MIMETYPE,
      });
      return [task];
    },

    prefix: THUMBNAIL_ROUTE,
  });


  fastify.register(fileItemPlugin, {
    shouldLimit: true,
    pathPrefix: filesPrefix,
    serviceMethod: serviceMethod,
    serviceOptions: {
      s3: fastify.s3FileItemPluginOptions,
      local: fastify.fileItemPluginOptions,
    },
    uploadPreHookTasks: async (id) => {
      throw new CannotEditPublicItem(id);
    },
    downloadPreHookTasks: async ({ itemId: id }) => {
      const task = new GetPublicItemTask(graaspActor, id, pIS, iS);
      task.getResult = () => {
      const extra = getFileExtra(serviceMethod, task.result.extra as FileItemExtra);
      return {
        filepath: extra.path,
        mimetype: extra.mimetype,
      };
    };
      return [task];
    },
  });

  fastify.get<{ Params: IdParam; Querystring: { withMemberships?: boolean } }>(
    '/:id',
    { schema: getOne },
    async ({ params: { id: itemId }, query: { withMemberships }, log }) => {
      const t1 = new GetPublicItemTask(graaspActor, itemId, pIS, iS);
      const t2 = new MergeItemMembershipsIntoItems(graaspActor, {}, pIS, iS, iMS);
      t2.skip = !withMemberships;
      t2.getInput = () => ({ items: [t1.result] as Item[] });
      // either pass result from get item
      if (!withMemberships) {
        t2.getResult = () => t1.result;
      }
      // or take first item to return a non-array
      else {
        t2.getResult = () => t2.result[0];
      }
      return runner.runSingleSequence([t1, t2], log);
    },
  );

  fastify.get<{ Params: IdParam; Querystring: { ordered?: boolean } }>(
    '/:id/children',
    { schema: getChildren },
    async ({ params: { id: itemId }, query: { ordered }, log }) => {
      const t1 = new GetPublicItemTask(graaspActor, itemId, pIS, iS);
      const t2 = iTM.createGetChildrenTask(graaspActor, {});
      t2.getInput = () => ({ ordered, item: t1.result });
      return runner.runSingleSequence([t1, t2], log);
    },
  );

  fastify.get<{ Querystring: { tagId: string; withMemberships?: boolean } }>(
    '/',
    { schema: getItemsBy },
    async ({ query: { tagId, withMemberships } }) => {
      // todo: use only one transaction
      const t1 = new GetPublicItemIdsWithTagTask(graaspActor, { tagId }, pIS, iS);
      const itemIds = await runner.runSingle(t1);

      // use item manager task to get trigger post hooks (deleted items are removed)
      const t2 = itemIds.map((id) => iTM.createGetTask(graaspActor, id));
      const items = (await runner.runMultiple(t2)) as Item[];
      // remove unavailable items
      const validItems = items.filter(({ id }) => id);
      if (!withMemberships) {
        return validItems;
      }
      const t3 = new MergeItemMembershipsIntoItems(
        graaspActor,
        { items: validItems },
        pIS,
        iS,
        iMS,
      );
      const result = await runner.runSingle(t3);
      return result;
    },
  );

  // categories
  fastify.register(PublicCategoriesPlugin, { publicActor: graaspActor });

  // TODO: optimize, this is a temporary solution
  // get public items in given category(ies)
  fastify.get<{ Querystring: { category: string[] } }>(
    '/with-categories',
    async ({ query: { category: categoryIds }, log }) => {
      const task = new GetItemsByCategoryTask(graaspActor, pIS, iS, { categoryIds });
      type resultType = { itemId: string };
      const itemIds = (await runner.runSingle(task, log)) as unknown as resultType[];

      // use item manager task to get trigger post hooks (deleted items are removed)
      const t2 = itemIds.map(({ itemId }) => iTM.createGetTask(graaspActor, itemId));
      const items = (await runner.runMultiple(t2)) as Item[];

      // filter out to keep published items only
      const result = (await Promise.all(items.map(
        async (item) => {
          const isAccessible =
            await pIS.hasPublicTag(item, db.pool) &&
            await pIS.hasTag(item, publishedTagId, db.pool);
          return isAccessible ? item : null;
        },
      ))).filter(Boolean);

      return result;
    },
  );

  //get category of an item
  fastify.get<{ Params: { itemId: string } }>(
    '/:itemId/categories',
    async ({ params: { itemId }, log }) => {
      const task = new GetItemCategoriesTask(graaspActor, pIS, iS, { itemId });
      return runner.runSingle(task, log);
    },
  );

  // endpoints requiring authentication
  fastify.register(async function (instance) {
    // check member is set in request, necessary to allow access to parent
    instance.addHook('preHandler', fastify.verifyAuthentication);

    instance.post<{ Params: IdParam; Body: { parentId?: string; shouldCopyTags?: boolean } }>(
      '/:id/copy',
      { schema: copyOne },
      async ({ member, params: { id: itemId }, body: { parentId, shouldCopyTags }, log }) => {
        const t1 = new GetPublicItemTask(member, itemId, pIS, iS);
        // do not copy tags by default
        const copyTasks = iTM.createCopySubTaskSequence(member, t1, {
          parentId,
          shouldCopyTags: shouldCopyTags ?? false,
        });
        return runner.runSingleSequence([t1, ...copyTasks], log);
      },
    );
  });
};

export default plugin;
