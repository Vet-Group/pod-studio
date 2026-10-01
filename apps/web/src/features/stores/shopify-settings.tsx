'use client';

import { useState, useTransition } from 'react';
import type { ShopifyConnectionView } from '@pod-studio/core';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/auth/field';
import { useHydrated } from '@/lib/use-hydrated';
import { connectionAction, saveCredentialsAction } from './shopify-actions';

const STATUS_LABELS = { unconfigured: 'Not configured', untested: 'Not tested', connected: 'Connected', failed: 'Connection failed' };
export function ShopifySettings({ storeId, connection }: { storeId: string; connection: ShopifyConnectionView }) {
  const hydrated = useHydrated();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const disabled = !hydrated || pending;
  function operate(operation: 'test' | 'rotate' | 'remove') {
    if (operation === 'remove' && !window.confirm('Remove the encrypted Shopify credentials?')) return;
    setError(''); setMessage('');
    startTransition(async () => {
      const result = await connectionAction(storeId, operation);
      if (!result.ok) setError(result.error);
      else setMessage(operation === 'test' ? 'Connection test finished.' : operation === 'rotate' ? 'Credentials re-encrypted with the active key.' : 'Credentials removed.');
    });
  }
  return <section className="border-line bg-paper rounded-card max-w-2xl space-y-6 border p-5 sm:p-6" aria-labelledby="connection-heading">
    <div className="space-y-2">
      <h2 id="connection-heading" className="text-lg font-semibold">Shopify connection</h2>
      <p className="text-sm text-muted">Credentials are encrypted at rest and are never displayed after saving.</p>
      <p className="text-sm font-medium" role="status">{STATUS_LABELS[connection.status]}</p>
      {connection.testedAt && <p className="text-sm text-muted">Last tested: <time dateTime={connection.testedAt}>{new Date(connection.testedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC</time></p>}
      {connection.configured && <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-muted">Saved client secret</dt><dd>{connection.clientSecret}</dd></div>
        <div><dt className="text-muted">Saved access token</dt><dd>{connection.accessToken}</dd></div>
      </dl>}
    </div>
    {connection.canEdit ? <>
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const input = { clientId: String(data.get('clientId') ?? ''), clientSecret: String(data.get('clientSecret') ?? ''), accessToken: String(data.get('accessToken') ?? '') };
        form.reset(); // Clear sensitive values immediately; never put secrets in React state or attributes.
        setError(''); setMessage('');
        startTransition(async () => {
          const result = await saveCredentialsAction(storeId, input);
          if (!result.ok) setError(result.error);
          else setMessage('Credentials saved.');
        });
      }}>
        <fieldset disabled={disabled} className="min-w-0 space-y-4">
          <legend className="sr-only">{connection.configured ? 'Replace Shopify credentials' : 'Configure Shopify credentials'}</legend>
          <Field label="Client ID" name="clientId" required maxLength={8192} autoComplete="off" />
          <Field label="Client secret" name="clientSecret" type="password" required maxLength={8192} autoComplete="new-password" />
          <Field label="Access token" name="accessToken" type="password" required maxLength={8192} autoComplete="new-password" />
          {connection.configured && <p className="text-sm text-muted">Saving replaces all credentials and resets the connection status.</p>}
          <Button variant="primary" className="min-h-11" type="submit" disabled={disabled}>Save credentials</Button>
        </fieldset>
      </form>
      {connection.configured && <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button variant="primary" className="min-h-11" disabled={disabled} onClick={() => operate('test')}>Test connection</Button>
        <Button variant="secondary" className="min-h-11" disabled={disabled} onClick={() => operate('rotate')}>Rotate encryption key</Button>
        <Button variant="secondary" className="min-h-11 text-orange" disabled={disabled} onClick={() => operate('remove')}>Remove credentials</Button>
      </div>}
    </> : <p className="text-sm text-muted">You do not have permission to edit this connection.</p>}
    {error && <p className="text-sm text-orange" role="alert">{error}</p>}
    {message && <p className="text-sm text-muted" role="status">{message}</p>}
  </section>;
}
