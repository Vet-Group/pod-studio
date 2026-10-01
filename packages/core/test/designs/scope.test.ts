import { describe, expect, it } from 'vitest';
import { auditLog, eq, storeMembers } from '@pod-studio/db';
import { createDesign, getDesignUrl, listDesigns, shareDesign } from '../../src/designs/designs';
import { A, B, admin, bytes, harness, outsider, owner, uploaded, viewer } from '../assets/harness';

describe('per-store design library', () => {
  it('keeps designs private to their upload store by default', async () => {
    const h = await harness();
    const { asset } = await uploaded(h);
    const design = await createDesign(h.db, owner, { storeId: A, assetId: asset.id, name: 'First design' });
    expect((await listDesigns(h.db, viewer, A)).map((r) => r.id)).toEqual([design.id]);
    expect(await listDesigns(h.db, outsider, B)).toEqual([]);
    await expect(getDesignUrl(h.db, h.storage, outsider, { storeId: B, designId: design.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(listDesigns(h.db, outsider, A)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createDesign(h.db, owner, { storeId: B, assetId: asset.id, name: 'Wrong scope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requires source share and destination upload permissions; sharing is atomic and audited once', async () => {
    const h = await harness();
    const { asset } = await uploaded(h);
    const design = await createDesign(h.db, owner, { storeId: A, assetId: asset.id, name: 'Shared design' });
    for (const principal of [viewer, outsider, admin]) {
      await expect(shareDesign(h.db, principal, { storeId: A, designId: design.id, targetStoreId: B })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await h.db.update(storeMembers).set({ permissions: ['store.view'] }).where(eq(storeMembers.storeId, B));
    await expect(shareDesign(h.db, owner, { storeId: A, designId: design.id, targetStoreId: B })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await h.db.update(storeMembers).set({ permissions: ['store.view', 'design.upload'] }).where(eq(storeMembers.storeId, B));
    await Promise.all([1, 2].map(() => shareDesign(h.db, owner, { storeId: A, designId: design.id, targetStoreId: B })));
    expect((await listDesigns(h.db, outsider, B)).map((r) => r.id)).toEqual([design.id]);
    const read = await getDesignUrl(h.db, h.storage, outsider, { storeId: B, designId: design.id });
    expect(Buffer.from(await (await fetch(read.url)).arrayBuffer())).toEqual(bytes);
    const logs = (await h.db.select().from(auditLog)).filter((r) => r.action === 'design.share');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorUserId: owner.userId, storeId: A, targetId: design.id, data: { targetStoreId: B } });
    expect(JSON.stringify(logs)).not.toContain('X-Amz');
    await h.db.update(storeMembers).set({ permissions: ['store.view', 'design.upload', 'design.share'] }).where(eq(storeMembers.storeId, B));
    await expect(shareDesign(h.db, owner, { storeId: B, designId: design.id, targetStoreId: A })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await h.db.delete(storeMembers).where(eq(storeMembers.userId, outsider.userId));
    await expect(getDesignUrl(h.db, h.storage, outsider, { storeId: B, designId: design.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
