import { text, timestamp } from 'drizzle-orm/pg-core';
import { newId } from '../ids';

/** Text primary key filled with {@link newId} when the caller does not supply one. */
export const id = () => text('id').primaryKey().$defaultFn(newId);

/** Every timestamp is `timestamptz`; there is no `timestamp without time zone` in the schema. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => timestamptz('created_at').notNull().defaultNow();

/** Database default covers inserts; Drizzle refreshes the value on every update it issues. */
export const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
