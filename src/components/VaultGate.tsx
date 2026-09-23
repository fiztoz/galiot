import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, Lock, ArrowRight, Check } from 'lucide-react';

interface VaultGateProps {
  children: React.ReactNode;
  onUnlockChange?: (unlocked: boolean) => void;
}

type GateState = 'loading' | 'create' | 'unlock' | 'unlocked';

export function VaultGate({ children, onUnlockChange }: VaultGateProps) {
  const [state, setState] = useState<GateState>('loading');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Simulate checking vault existence (mock PGlite/IndexedDB check)
    const checkVault = async () => {
      // Small delay to simulate async check
      await new Promise(resolve => setTimeout(resolve, 500));
      const hasVault = localStorage.getItem('galiot_mock_vault_exists') === 'true';
      const isUnlocked = sessionStorage.getItem('galiot_mock_vault_unlocked') === 'true';

      if (isUnlocked) {
        setState('unlocked');
        onUnlockChange?.(true);
      } else if (hasVault) {
        setState('unlock');
        onUnlockChange?.(false);
      } else {
        setState('create');
        onUnlockChange?.(false);
      }
    };
    
    checkVault();
  }, [onUnlockChange]);

  const handleCreateVault = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Passphrase must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passphrases do not match.');
      return;
    }

    // Mock create vault
    localStorage.setItem('galiot_mock_vault_exists', 'true');
    sessionStorage.setItem('galiot_mock_vault_unlocked', 'true');
    setState('unlocked');
    onUnlockChange?.(true);
  };

  const handleUnlockVault = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!password) {
      setError('Please enter your passphrase.');
      return;
    }

    // Mock unlock vault (accept any password for now)
    sessionStorage.setItem('galiot_mock_vault_unlocked', 'true');
    setState('unlocked');
    onUnlockChange?.(true);
  };

  if (state === 'loading') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-600"></div>
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400 font-medium">Checking vault...</p>
      </div>
    );
  }

  if (state === 'unlocked') {
    return <>{children}</>;
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-zinc-50/50 dark:bg-zinc-950/50">
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-8 max-w-md w-full shadow-lg shadow-zinc-200/50 dark:shadow-none">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-teal-100/50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-500 mb-4">
            <Lock size={24} />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            {state === 'create' ? 'Create Master Vault' : 'Unlock Vault'}
          </h2>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            {state === 'create' 
              ? 'Your passphrase encrypts all cloud credentials locally. It never leaves your browser.'
              : 'Enter your master passphrase to unlock your connections.'}
          </p>
        </div>

        <form onSubmit={state === 'create' ? handleCreateVault : handleUnlockVault} className="space-y-4">
          <div>
            <label htmlFor="passphrase" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Master Passphrase
            </label>
            <div className="relative">
              <input
                id="passphrase"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-4 pr-10 py-2.5 bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent dark:text-zinc-100 transition-shadow"
                placeholder={state === 'create' ? 'Minimum 8 characters' : 'Enter passphrase'}
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

          {state === 'create' && (
            <div>
              <label htmlFor="confirm-passphrase" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Confirm Passphrase
              </label>
              <input
                id="confirm-passphrase"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-2.5 bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent dark:text-zinc-100 transition-shadow"
                placeholder="Confirm your passphrase"
              />
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-lg border border-red-100 dark:border-red-900/30">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="w-full mt-6 inline-flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900"
          >
            {state === 'create' ? (
              <>
                Create Vault
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
      </div>
    </div>
  );
}
