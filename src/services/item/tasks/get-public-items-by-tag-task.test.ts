import { DatabaseTransactionHandler, ItemService } from 'graasp';
import { buildMember, PUBLIC_ITEM_CHILDREN, PUBLIC_TAG_ID } from '../../../../test/constants';
import { PublicItemService } from '../db-service';
import { GetPublicItemsWithTagTask } from './get-public-items-by-tag-task';

const actor = buildMember();
const publicItemService = new PublicItemService(PUBLIC_TAG_ID);
const itemService = {
  get: jest.fn(),
  getDescendants: jest.fn(),
} as unknown as ItemService;
const handler = {} as unknown as DatabaseTransactionHandler;

const tagId = PUBLIC_TAG_ID;

describe('GetPublicItemsWithTagTask', () => {
  it('Get public items by tag', async () => {
    const children = PUBLIC_ITEM_CHILDREN;
    jest.spyOn(publicItemService, 'getPublicItemsByTag').mockResolvedValue(children);
    const task = new GetPublicItemsWithTagTask(actor, { tagId }, publicItemService, itemService);

    await task.run(handler);
    expect(task.result).toEqual(children);
  });
});
