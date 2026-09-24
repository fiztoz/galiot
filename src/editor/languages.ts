/**
 * CodeMirror language wiring.
 *
 * Every package is imported dynamically so opening a Python file does not
 * download the Rust, TOML and diff parsers. The whole module is reached only
 * through the lazily loaded editor, so first load stays small.
 */

import type { Extension } from '@codemirror/state';
import type { LanguageSupport, StreamParser } from '@codemirror/language';
import type { EditorLanguage } from './filetypes';

type LegacyKey = Extract<
  EditorLanguage,
  'shell' | 'toml' | 'ini' | 'dockerfile' | 'rust' | 'ruby' | 'diff'
>;

const LEGACY_LOADERS: Record<LegacyKey, () => Promise<StreamParser<unknown>>> = {
  shell: async () => (await import('@codemirror/legacy-modes/mode/shell')).shell,
  toml: async () => (await import('@codemirror/legacy-modes/mode/toml')).toml,
  ini: async () => (await import('@codemirror/legacy-modes/mode/properties')).properties,
  dockerfile: async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile,
  rust: async () => (await import('@codemirror/legacy-modes/mode/rust')).rust,
  ruby: async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby,
  diff: async () => (await import('@codemirror/legacy-modes/mode/diff')).diff,
};

/** Loads only the language package the current file needs. */
export async function languageSupport(language: EditorLanguage): Promise<Extension | undefined> {
  switch (language) {
    case 'javascript': {
      const m = await import('@codemirror/lang-javascript');
      return m.javascript();
    }
    case 'json': {
      const m = await import('@codemirror/lang-json');
      return m.json();
    }
    case 'markdown': {
      const m = await import('@codemirror/lang-markdown');
      return m.markdown();
    }
    case 'python': {
      const m = await import('@codemirror/lang-python');
      return m.python();
    }
    case 'html': {
      const m = await import('@codemirror/lang-html');
      return m.html();
    }
    case 'css': {
      const m = await import('@codemirror/lang-css');
      return m.css();
    }
    case 'sql': {
      const m = await import('@codemirror/lang-sql');
      return m.sql();
    }
    case 'yaml': {
      const m = await import('@codemirror/lang-yaml');
      return m.yaml();
    }
    case 'text':
      return undefined;
    default: {
      const loader = LEGACY_LOADERS[language as LegacyKey];
      if (!loader) return undefined;
      const { StreamLanguage } = await import('@codemirror/language');
      return StreamLanguage.define(await loader());
    }
  }
}

export type { LanguageSupport };
