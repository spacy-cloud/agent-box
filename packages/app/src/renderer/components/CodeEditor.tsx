import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import type { Diagnostic } from '@codemirror/lint';
import { yaml } from '@codemirror/lang-yaml';
import { tags } from '@lezer/highlight';

export interface EditorIssue {
  message: string;
  line?: number;
  column?: number;
}

// Colours come from the app's CSS variables (light and dark, WCAG AA against the editor background).
const highlight = HighlightStyle.define([
  { tag: [tags.propertyName, tags.definitionKeyword], color: 'var(--accent)' },
  { tag: [tags.string, tags.content], color: 'var(--text)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--warn-fg)' },
  { tag: [tags.comment, tags.lineComment], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.meta, tags.separator, tags.punctuation], color: 'var(--muted)' },
  { tag: [tags.labelName, tags.typeName], color: 'var(--ok-fg)' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--text)', height: '100%' },
  '.cm-content': { fontFamily: 'var(--mono)', fontSize: '13px', caretColor: 'var(--text)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
  '&.cm-focused': { outline: '2px solid var(--focus)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--info-bg) !important',
  },
  '.cm-scroller': { overflow: 'auto' },
});

/** Diagnostics from the validator's line/column positions (1-based). Issues without a position are not drawn. */
export function toDiagnostics(state: EditorState, issues: readonly EditorIssue[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const i of issues) {
    if (!i.line || i.line < 1 || i.line > state.doc.lines) continue;
    const line = state.doc.line(i.line);
    const from = Math.min(line.from + Math.max((i.column ?? 1) - 1, 0), line.to);
    out.push({ from, to: Math.max(from, line.to), severity: 'error', message: i.message });
  }
  return out;
}

/**
 * CodeMirror 6 with YAML syntax highlighting. The text lives in the parent (`value`); edits are reported through
 * `onChange`. Validation issues are drawn as markers at their line. The editor does not trap Tab (keyboard users
 * can leave it); `label` is its accessible name.
 */
export function YamlEditor(props: {
  value: string;
  onChange(value: string): void;
  readOnly?: boolean;
  label: string;
  issues: readonly EditorIssue[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      lintGutter(),
      yaml(),
      syntaxHighlighting(highlight),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      theme,
      EditorState.readOnly.of(Boolean(props.readOnly)),
      EditorView.editable.of(!props.readOnly),
      EditorView.contentAttributes.of({ 'aria-label': props.label, spellcheck: 'false' }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange.current(u.state.doc.toString());
      }),
    ];
    const v = new EditorView({
      state: EditorState.create({ doc: props.value, extensions }),
      parent: host.current,
    });
    view.current = v;
    // A scrollable region must be reachable by keyboard (also when the editor is read-only).
    v.scrollDOM.tabIndex = 0;
    v.scrollDOM.setAttribute('role', 'group');
    v.scrollDOM.setAttribute('aria-label', props.label);
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is recreated only when its mode or label changes; the text is synchronised below.
  }, [props.readOnly, props.label]);

  // Text changed from outside (the form, loading another template).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== props.value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
    }
  }, [props.value, props.readOnly, props.label]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch(setDiagnostics(v.state, toDiagnostics(v.state, props.issues)));
  }, [props.issues, props.value, props.readOnly, props.label]);

  return <div className="cm-host" ref={host} />;
}
