import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { MergeView, type DirectMergeConfig } from '@codemirror/merge';
import { X, Save, Columns2, PenLine, Loader2, AlertTriangle, CheckCircle2, FileText } from 'lucide-react';
import type { AppDB, ConnectionRow, ObjectRow } from '../db/client';
import { profileConfig } from '../db/objects';
import { getSealedCredentials } from '../vault/repository';
import { vaultService } from '../vault/vaultService';
import { detectLanguage, mediaKind } from './filetypes';
import { languageSupport } from './languages';
import { formatBytes } from '../lib/format';
import { FilePreview } from './FilePreview';

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
  const [mode, setMode] = useState<Mode>('edit');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [original, setOriginal] = useState('');
  const [media, setMedia] = useState<'image' | 'pdf' | 'audio' | 'video' | null>(null);
  const [langSupport, setLangSupport] = useState<Extension | undefined>(undefined);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const currentTextRef = useRef('');

  const filename = useMemo(() => file.filename || file.key.split('/').pop() || file.key, [file]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sealed = await getSealedCredentials(db, profile.id);
      const result = await vaultService.call('s3.getText', {
        profile: profileConfig(profile),
        credentials: { sealed },
        key: file.key,
      });
      setOriginal(result.text);
      currentTextRef.current = result.text;
      setMedia(mediaKind(filename, result.contentType));
      setLangSupport(await languageSupport(detectLanguage(filename)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [db, profile, file.key, filename]);

  useEffect(() => {
    void load();
  }, [load]);

  // Mount the CodeMirror view for the loaded text.
  useEffect(() => {
    if (loading || error || media !== null || langSupport === undefined) return;
    const container = containerRef.current;
    if (!container || viewRef.current) return;
    if (detectLanguage(filename) === 'text' && langSupport === undefined) return;

    const state = EditorState.create({
      doc: original,
      extensions: [
        ...baseExtensions(langSupport),
        darkTheme,
        lightTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            currentTextRef.current = update.state.doc.toString();
            setDirty(true);
            setNotice(null);
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [loading, error, media, original, filename, langSupport]);

  // Mount the side-by-side merge view on demand.
  useEffect(() => {
    if (mode !== 'diff' || !viewRef.current || langSupport === undefined) return;
    const container = containerRef.current;
    if (!container || mergeRef.current) return;

    const view = viewRef.current;
    view.dom.style.display = 'none';

    const label = (name: string) => EditorView.contentAttributes.of({ 'aria-label': name });

    const config: DirectMergeConfig = {
      a: {
        doc: original,
        extensions: [
          ...baseExtensions(langSupport),
          darkTheme,
          lightTheme,
          label('Remote version'),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      b: {
        doc: currentTextRef.current,
        extensions: [
          ...baseExtensions(langSupport),
          darkTheme,
          lightTheme,
          label('Local edits'),
        ],
      },
      parent: container,
      orientation: 'a-b',
      highlightChanges: true,
      gutter: true,
    };

    const merge = new MergeView(config);
    mergeRef.current = merge;
    return () => {
      merge.destroy();
      mergeRef.current = null;
      view.dom.style.display = '';
    };
  }, [mode, original, filename, langSupport]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const sealed = await getSealedCredentials(db, profile.id);
      const text = currentTextRef.current;
      const result = await vaultService.call('s3.putText', {
        profile: profileConfig(profile),
        credentials: { sealed },
        key: file.key,
        body: text,
        contentType: 'text/plain; charset=utf-8',
      });

      setOriginal(text);
      setDirty(false);
      setNotice(`Uploaded — ETag ${result.eTag.slice(0, 24)}${result.eTag.length > 24 ? '…' : ''}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [db, profile, file.key, onSaved]);

  return (
    <div className="fixed inset-0 z-50 bg-zinc-50 dark:bg-zinc-950 flex flex-col">
      <header className="flex-none flex items-center gap-3 px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <FileText size={16} className="text-teal-500 flex-none" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50 truncate" title={file.key}>
            {filename}
          </p>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {formatBytes(Number(file.size))} · {detectLanguage(filename)}
            {dirty ? ' · unsaved changes' : ''}
          </p>
        </div>

        <div className="flex-1" />

        {media === null && (
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

        {media === null && (
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save & upload
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          aria-label="Close editor"
        >
          <X size={16} />
        </button>
      </header>

      {error && (
        <div className="flex-none flex items-start gap-2 px-4 py-2 bg-red-50 dark:bg-red-950/40 border-b border-red-100 dark:border-red-900/40 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle size={14} className="flex-none mt-0.5" />
          <span className="break-words">{error}</span>
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
            <Loader2 size={20} className="animate-spin text-zinc-400" />
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
