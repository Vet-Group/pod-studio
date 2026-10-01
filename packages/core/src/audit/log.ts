import { auditLog, newId, type Database } from '@pod-studio/db';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  storeId?: string | null;
  data?: Record<string, unknown>;
}

/** Appends one audit_log row. Never pass secrets (tokens, passwords) in `data`. */
export async function writeAudit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    id: newId(),
    actorKind: entry.actorUserId ? 'user' : 'system',
    actorUserId: entry.actorUserId,
    storeId: entry.storeId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    data: entry.data ?? {},
  });
}
