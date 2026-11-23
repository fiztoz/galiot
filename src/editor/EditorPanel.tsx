import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { MergeView } from '@codemirror/merge';
import { X, Save, Columns2, PenLine, Loader2, AlertTriangle, CheckCircle2, FileText, Maximize2, Minimize2 } from 'lucide-react';
import type { AppDB, ConnectionRow, ObjectRow } from '../db/client';
import { profileConfig, listingCredentials } from '../db/objects';
import { vaultService } from '../vault/vaultService';
import { detectLanguage, hasTypeClue, mediaKind, type EditorLanguage, type PreviewKind } from './filetypes';
import { SNIFF_LIMIT, sampleStream, sniffBytes } from './sniff';
import { languageSupport } from './languages';
import { formatBytes } from '../lib/format';
import { useFocusTrap } from '../lib/useFocusTrap';
import { FilePreview } from './FilePreview';
import { isStrongETag } from '../s3/clientHeaders';

interface EditorPanelProps {
  db: AppDB;
  profile: ConnectionRow;
  file: ObjectRow;
  onClose: () => void;
  onSaved: () => void;
}

type Mode = 'edit' | 'diff';

/** Mirrors @codemirror/theme-one-dark defaults without pulling the package in. */
const darkTheme = EditorView.theme(
  {
    '&': { color: '#e4e4e7', backgroundColor: '#18181b', height: '100%' },
    '.cm-content': { caretColor: '#2dd4bf', fontFamily: 'var(--font-mono)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#2dd4bf' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#134e4a80',
    },
    '.cm-gutters': {
      backgroundColor: '#18181b',
      color: '#71717a',
      border: 'none',
      borderRight: '1px solid #27272a',
    },
    '.cm-activeLine': { backgroundColor: '#ffffff08' },
    '.cm-activeLineGutter': { backgroundColor: '#ffffff08', color: '#a1a1aa' },
    '.cm-searchMatch': { backgroundColor: '#2dd4bf33' },
    '.cm-selectionMatch': { backgroundColor: '#14b8a633' },
  },
  { dark: true },
);

const lightTheme = EditorView.theme({
  '&': { color: '#18181b', backgroundColor: '#ffffff', height: '100%' },
  '.cm-content': { caretColor: '#0d9488', fontFamily: 'var(--font-mono)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#0d9488' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#ccfbf180' },
  '.cm-gutters': { backgroundColor: '#fafafa', color: '#a1a1aa', border: 'none', borderRight: '1px solid #e4e4e7' },
  '.cm-activeLine': { backgroundColor: '#00000006' },
});

export interface EditorMountState {
  loading: boolean;
  error: string | null;
  media: PreviewKind | null;
  /** Whether language resolution has finished — *not* whether it found a grammar. */
  langResolved: boolean;
}

/**
 * Whether the CodeMirror view may mount.
 *
 * Extracted and pure so the decision is unit-testable: the bug this replaces
 * gated on `langSupport === undefined`, which is also the *correct* value for
 * plain text, so every `.txt`, `.log`, `.csv` and unknown extension opened a
 * dead panel with no editor, no spinner and no error. "Not loaded yet" and
 * "nothing to load" have to stay distinct.
 */
export function canMountEditor(state: EditorMountState): boolean {
  if (state.loading) return false;
  if (state.error) return false;
  if (state.media !== null) return false;
  return state.langResolved;
}

function baseExtensions(support: Extension | undefined): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    EditorView.lineWrapping,
    ...(support ? [support] : []),
  ];
}

export function EditorPanel({ db, profile, file, onClose, onSaved }: EditorPanelProps) {
  const filename = useMemo(() => file.filename || file.key.split('/').pop() || file.key, [file]);
  const [mode, setMode] = useState<Mode>('edit');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [eTag, setETag] = useState<string | null>(null);
  const [contentType, setContentType] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [original, setOriginal] = useState('');
  const [media, setMedia] = useState<PreviewKind | null>(() =>
    mediaKind(filename, file.content_type),
  );
  /** Grammar chosen from content when the filename had no extension clue. */
  const [contentLang, setContentLang] = useState<EditorLanguage | null>(null);
  /** Media previews dock beside the table (master-detail); editing stays full-screen. */
  const [expandMedia, setExpandMedia] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const canDock = workspaceWidth >= 768;
  const docked = media !== null && canDock && !expandMedia;
  const maxPanelWidth = Math.max(320, Math.min(720, workspaceWidth - 384));
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = typeof localStorage === 'undefined' ? NaN : Number(localStorage.getItem('galiot.previewWidth'));
    return Number.isFinite(stored) && stored >= 320 && stored <= 720 ? stored : 560;
  });
  const dragPointer = useRef<number | null>(null);
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('galiot.previewWidth', String(panelWidth));
  }, [panelWidth]);
  const [langSupport, setLangSupport] = useState<Extension | undefined>(undefined);
  /**
   * Whether language resolution has finished.
   *
   * `langSupport === undefined` cannot serve as the "still loading" signal:
   * plain text has no grammar, so `languageSupport('text')` resolves to
   * `undefined` on purpose. Conflating the two meant every `.txt`, `.log`,
   * `.csv` and unknown-extension file opened a dead panel — no editor, no
   * spinner, no error — because the mount effect bailed on a value that was
   * never going to change.
   */
  const [langResolved, setLangResolved] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const currentTextRef = useRef('');

  const trapRef = useFocusTrap<HTMLDivElement>(!docked);
  useLayoutEffect(() => {
    // Measure the shared Explorer/preview workspace, not the viewport: the
    // local-files pane can also occupy space. The dock is a real flex sibling.
    const workspace = trapRef.current?.parentElement;
    if (!workspace) return;
    const measure = () => setWorkspaceWidth(Math.floor(workspace.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [trapRef]);

  /** Asks before discarding a draft; Escape on that prompt keeps editing. */
  const [confirmingClose, setConfirmingClose] = useState(false);
  const requestClose = useCallback(() => {
    if (dirty) setConfirmingClose(true);
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !saving) {
        if (confirmingClose) setConfirmingClose(false);
        else requestClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [requestClose, confirmingClose, saving]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const readRemote = useCallback(async () => {
    const sealed = await listingCredentials(db, profile);
    return vaultService.call('s3.getText', {
      profile: profileConfig(profile), credentials: { sealed }, key: file.key,
    });
  }, [db, profile, file.key]);

  /**
   * Leading bytes of the object through the same-origin media stream, for
   * content sniffing. Asks for a range but tolerates providers that ignore
   * it: only the first SNIFF_LIMIT bytes are kept and the rest is cancelled.
   */
  const readSample = useCallback(async () => {
    const sealed = await listingCredentials(db, profile);
    const { url } = await vaultService.call('s3.mediaUrl', {
      profile: profileConfig(profile), credentials: { sealed }, key: file.key,
    });
    const token = url.split('/').pop() ?? '';
    try {
      const response = await fetch(url, { headers: { Range: `bytes=0-${SNIFF_LIMIT - 1}` } });
      if (!response.ok) {
        throw new Error(`Type detection could not read the object (HTTP ${response.status}).`);
      }
      return await sampleStream(response);
    } finally {
      // One-shot grant: hand it back as soon as the sample is read (or fails).
      void vaultService
        .call('s3.revokeMedia', { profile: profileConfig(profile), credentials: { sealed }, token })
        .catch(() => {});
    }
  }, [db, profile, file.key]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLangResolved(false);
    setDirty(false);
    setError(null);
    setSaveError(null);
    setNotice(null);
    setETag(null);
    setContentLang(null);
    async function load() {
      try {
        const detectedMedia = mediaKind(filename, file.content_type);
        if (detectedMedia !== null) {
          setMedia(detectedMedia);
          return;
        }

        // No extension (or one nobody recognises): let the first bytes decide
        // between media preview, text editor and opaque binary.
        let sample: string | undefined;
        if (!hasTypeClue(filename)) {
          const sniffed = sniffBytes(await readSample());
          if (!active) return;
          if (sniffed.kind !== null) {
            setMedia(sniffed.kind);
            return;
          }
          sample = sniffed.text ?? undefined;
        }

        const result = await readRemote();
        const language = detectLanguage(filename, sample);
        const support = await languageSupport(language);
        if (!active) return;
        setContentLang(language);
        setOriginal(result.text);
        setETag(result.conditionalPut ? result.eTag : null);
        setContentType(result.contentType);
        currentTextRef.current = result.text;
        setMedia(mediaKind(filename, result.contentType));
        setLangSupport(support);
        if (!result.conditionalPut) {
          setNotice(`Read only — ${result.editorWriteIssue ?? 'conditional writes have not been verified for this bucket.'}`);
        }
        else if (!isStrongETag(result.eTag)) setNotice('Read only — the provider did not return a strong ETag.');
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) {
          setLangResolved(true);
          setLoading(false);
        }
      }
    }
    void load();
    return () => { active = false; };
  }, [readRemote, readSample, file.content_type, filename]);

  // Mount the CodeMirror view for the loaded text.
  useEffect(() => {
    // `langSupport` may legitimately be undefined (plain text has no grammar),
    // so the gate is `canMountEditor` — resolution finished — not the extension.
    if (!canMountEditor({ loading, error, media, langResolved })) return;
    const container = containerRef.current;
    if (!container) return;
    const base = [...baseExtensions(langSupport), darkTheme, lightTheme, EditorState.lineSeparator.of('\n')];
    const draft = {
      doc: currentTextRef.current,
      extensions: [
        ...base,
        EditorView.contentAttributes.of({ 'aria-label': 'Local edits' }),
        EditorState.readOnly.of(!isStrongETag(eTag)),
        EditorView.editable.of(isStrongETag(eTag)),
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return;
          currentTextRef.current = update.state.sliceDoc();
          setDirty(currentTextRef.current !== original);
          setNotice(null);
        }),
      ],
    };
    const view = mode === 'edit'
      ? new EditorView({ state: EditorState.create(draft), parent: container })
      : new MergeView({
          a: {
            doc: original,
            extensions: [
              ...base, EditorView.contentAttributes.of({ 'aria-label': 'Remote version' }),
              EditorState.readOnly.of(true), EditorView.editable.of(false),
            ],
          },
          b: draft,
          parent: container,
          orientation: 'a-b',
          gutter: true,
          highlightChanges: true,
        });
    return () => view.destroy();
  }, [mode, loading, error, media, original, eTag, langSupport, langResolved]);

  const handleSave = useCallback(async () => {
    if (!isStrongETag(eTag) || saving) return;
    setSaving(true);
    setSaveError(null);
    const text = currentTextRef.current;
    try {
      const sealed = await listingCredentials(db, profile);
      const result = await vaultService.call('s3.putText', {
        profile: profileConfig(profile),
        credentials: { sealed },
        key: file.key,
        body: text,
        contentType,
        eTag,
      });

      setOriginal(text);
      setDirty(currentTextRef.current !== text);
      setETag(result.eTag);
      setNotice(isStrongETag(result.eTag) ? 'Changes uploaded.' : 'Uploaded. Reopen to obtain an ETag before saving again.');
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [db, profile, file.key, onSaved, saving, eTag, contentType]);

  async function compareLatest() {
    setSaving(true);
    try {
      const result = await readRemote();
      if (!result.conditionalPut) {
        throw new Error(`${result.editorWriteIssue ?? 'Conditional writes are unavailable for this bucket.'} Your draft is still open.`);
      }
      if (!isStrongETag(result.eTag)) throw new Error('The latest version has no strong ETag. Your draft is still open.');
      setOriginal(result.text);
      setContentType(result.contentType);
      setETag(result.eTag);
      setDirty(currentTextRef.current !== result.text);
      setMode('diff');
      setSaveError(null);
      setNotice('Review your draft against the latest remote version before saving.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal={docked ? undefined : true}
      aria-label={filename}
      className={
        docked
          ? 'relative flex-none min-h-0 bg-zinc-50 dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 flex flex-col'
          : 'fixed inset-0 z-50 bg-zinc-50 dark:bg-zinc-950 flex flex-col'
      }
      style={docked ? { width: Math.min(panelWidth, maxPanelWidth) } : undefined}
    >
      {docked && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview panel"
          aria-valuemin={320}
          aria-valuemax={maxPanelWidth}
          aria-valuenow={Math.min(panelWidth, maxPanelWidth)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragPointer.current = event.pointerId;
          }}
          onPointerMove={(event) => {
            if (dragPointer.current !== event.pointerId) return;
            const right = event.currentTarget.parentElement!.getBoundingClientRect().right;
            setPanelWidth(Math.min(maxPanelWidth, Math.max(320, Math.round(right - event.clientX))));
          }}
          onLostPointerCapture={() => { dragPointer.current = null; }}
          onPointerUp={() => { dragPointer.current = null; }}
          onPointerCancel={() => { dragPointer.current = null; }}
          onKeyDown={(event) => {
            const current = Math.min(panelWidth, maxPanelWidth);
            if (event.key === 'ArrowLeft') setPanelWidth(Math.min(maxPanelWidth, current + 40));
            else if (event.key === 'ArrowRight') setPanelWidth(Math.max(320, current - 40));
            else if (event.key === 'Home') setPanelWidth(320);
            else if (event.key === 'End') setPanelWidth(maxPanelWidth);
            else return;
            event.preventDefault();
          }}
          className="absolute z-10 left-0 top-0 bottom-0 w-1.5 touch-none cursor-col-resize hover:bg-teal-500/40 focus-visible:bg-teal-500/60 transition-colors"
        />
      )}
      <header className="flex-none flex items-center gap-3 px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <FileText size={16} className="text-teal-500 flex-none" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50 truncate" title={file.key}>
            {filename}
          </p>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {formatBytes(Number(file.size))} ·{' '}
            {media === 'binary' ? 'binary file' : (media ?? contentLang ?? detectLanguage(filename))}
            {dirty ? ' · unsaved changes' : ''}
          </p>
        </div>

        <div className="flex-1" />

        {media === null && !error && (
          <div className="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <button
              type="button"
              onClick={() => setMode('edit')}
              aria-pressed={mode === 'edit'}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors ${
                mode === 'edit'
                  ? 'bg-teal-600 text-white'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              <PenLine size={13} />
              Edit
            </button>
            <button
              type="button"
              onClick={() => setMode('diff')}
              aria-pressed={mode === 'diff'}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors ${
                mode === 'diff'
                  ? 'bg-teal-600 text-white'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              <Columns2 size={13} />
              Diff
            </button>
          </div>
        )}

        {media === null && !error && (
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !dirty || !isStrongETag(eTag)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save & upload
          </button>
        )}

        {media !== null && canDock && (
          <button
            type="button"
            onClick={() => setExpandMedia((v) => !v)}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label={docked ? 'Expand preview to full screen' : 'Dock preview beside the table'}
            title={docked ? 'Expand to full screen' : 'Dock beside the table'}
          >
            {docked ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
          </button>
        )}
        <button
          type="button"
          onClick={requestClose}
          className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          aria-label="Close editor"
        >
          <X size={16} />
        </button>
      </header>

      {confirmingClose && (
        <div role="alertdialog" aria-label="Discard unsaved changes?" className="flex-none flex flex-wrap items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-100 dark:border-amber-900/40 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle size={14} className="flex-none" />
          <span className="flex-1 min-w-0">Discard your unsaved changes to {filename}?</span>
          <button type="button" autoFocus onClick={() => setConfirmingClose(false)} className="px-2.5 py-1 rounded-lg text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40">
            Keep editing
          </button>
          <button type="button" onClick={onClose} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-red-600 hover:bg-red-700 text-white">
            Discard
          </button>
        </div>
      )}

      {(error || saveError) && (
        <div className="flex-none flex items-start gap-2 px-4 py-2 bg-red-50 dark:bg-red-950/40 border-b border-red-100 dark:border-red-900/40 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle size={14} className="flex-none mt-0.5" />
          <span className="break-words">{error || saveError}</span>
          {saveError && <button type="button" disabled={saving} onClick={() => void compareLatest()} className="underline">Compare with latest</button>}
        </div>
      )}

      {notice && (
        <div className="flex-none flex items-center gap-2 px-4 py-2 bg-teal-50 dark:bg-teal-950/30 border-b border-teal-100 dark:border-teal-900/40 text-xs text-teal-800 dark:text-teal-300">
          <CheckCircle2 size={14} className="flex-none" />
          {notice}
        </div>
      )}

      <div className="flex-1 min-h-0 relative">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 size={20} className="animate-spin text-zinc-500" />
          </div>
        ) : media !== null ? (
          <FilePreview db={db} profile={profile} file={file} kind={media} />
        ) : (
          <div ref={containerRef} className="h-full overflow-hidden" />
        )}
      </div>
    </div>
  );
}
