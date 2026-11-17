import React, { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Lock, ArrowRight, Check, Loader2, ShieldCheck } from 'lucide-react';
import type { AppDB } from '../db/client';
import { createVault, unlockVault, vaultExists, isVaultUnlocked } from '../vault/repository';
import { vaultService } from '../vault/vaultService';

interface VaultGateProps {
  db: AppDB;
  children: React.ReactNode;
  onUnlockChange?: (unlocked: boolean) => void;
}

type GateState = 'loading' | 'create' | 'unlock' | 'unlocked';

export function VaultGate({ db, children, onUnlockChange }: VaultGateProps) {
  const [state, setState] = useState<GateState>('loading');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [exists, unlocked] = await Promise.all([vaultExists(db), isVaultUnlocked()]);
        if (cancelled) return;
        if (unlocked) {
          setState('unlocked');
          onUnlockChange?.(true);
        } else {
          setState(exists ? 'unlock' : 'create');
          onUnlockChange?.(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setState('create');
        }
      }
    })();

    // Covers both idle auto-lock and an explicit vault deletion: if the vault
    // no longer exists, fall back to the create screen instead of unlock.
    const unsubscribe = vaultService.onLocked(() => {
      if (cancelled) return;
      setPassword('');
      setConfirmPassword('');
      onUnlockChange?.(false);
      setState('unlock');
      setNotice('Locked after inactivity. Enter your password to continue.');

      void (async () => {
        try {
          if (!(await vaultExists(db))) {
            setNotice('The vault was deleted. Create a new one to continue.');
            setState('create');
          }
        } catch {
          // Leave the unlock screen as-is; the user can retry.
        }
      })();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [db, onUnlockChange]);

  const handleCreateVault = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setNotice(null);

      if (password.length < 8) {
        setError('Password must be at least 8 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }

      setBusy(true);
      try {
        await createVault(db, password);
        setPassword('');
        setConfirmPassword('');
        setState('unlocked');
        onUnlockChange?.(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [db, password, confirmPassword, onUnlockChange],
  );

  const handleUnlockVault = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setNotice(null);

      if (!password) {
        setError('Please enter your password.');
        return;
      }

      setBusy(true);
      try {
        await unlockVault(db, password);
        setPassword('');
        setState('unlocked');
        onUnlockChange?.(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [db, password, onUnlockChange],
  );

  if (state === 'loading') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-600"></div>
        <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300 font-medium">Checking your lock…</p>
      </div>
    );
  }

  if (state === 'unlocked') {
    return <>{children}</>;
  }

  const isCreate = state === 'create';

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-zinc-50/50 dark:bg-zinc-950/50">
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-8 max-w-md w-full shadow-lg shadow-zinc-200/50 dark:shadow-none">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-teal-100/50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-500 mb-4">
            <Lock size={24} />
          </div>
          <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            {isCreate ? 'Set a master password' : 'Unlock'}
          </h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            {isCreate
              ? 'This password seals your S3 keys in this browser. While a bucket is open, your Galiot server uses those keys in memory. It does not store them.'
              : 'Enter your password to open your S3 connections.'}
          </p>
        </div>

        <form onSubmit={isCreate ? handleCreateVault : handleUnlockVault} className="space-y-4">
          <div>
            <label htmlFor="passphrase" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Master password
            </label>
            <div className="relative">
              <input
                id="passphrase"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                className="w-full pl-4 pr-10 py-2.5 bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent dark:text-zinc-100 transition-shadow disabled:opacity-60"
                placeholder={isCreate ? 'Minimum 8 characters' : 'Enter your password'}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 focus:outline-none"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {isCreate && (
            <div>
              <label htmlFor="confirm-passphrase" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Confirm password
              </label>
              <input
                id="confirm-passphrase"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={busy}
                className="w-full px-4 py-2.5 bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent dark:text-zinc-100 transition-shadow disabled:opacity-60"
                placeholder="Confirm your password"
              />
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-lg border border-red-100 dark:border-red-900/30">
              {error}
            </div>
          )}

          {notice && !error && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-sm rounded-lg border border-amber-100 dark:border-amber-900/30">
              {notice}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full mt-6 inline-flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900 disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {busy ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                {isCreate ? 'Setting password…' : 'Unlocking…'}
              </>
            ) : isCreate ? (
              <>
                Set password and continue
                <Check size={18} />
              </>
            ) : (
              <>
                Unlock
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>

        <p className="mt-6 flex items-start gap-2 text-xs text-zinc-400 dark:text-zinc-500 leading-relaxed">
          <ShieldCheck size={14} className="flex-none mt-0.5" />
          <span>
            The password stays in this browser. S3 keys are sealed here, then used only by the server you are running, and only while unlocked.
          </span>
        </p>
      </div>
    </div>
  );
}
