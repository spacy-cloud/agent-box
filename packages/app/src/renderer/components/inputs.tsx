import { useEffect, useRef, useState } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

/**
 * Inputs that edit a value derived from a document (the template YAML). They keep what the user is typing in
 * local state and only take over the external value when it means something else than the local text. Without
 * this, `1.` (on the way to `1.5`) would be normalised away while typing, or a list would lose focus on every key.
 */

function useSynced(
  external: string,
  same: (local: string, external: string) => boolean,
): [string, (v: string) => void] {
  const [local, setLocal] = useState(external);
  const localRef = useRef(local);
  localRef.current = local;
  useEffect(() => {
    if (!same(localRef.current, external)) setLocal(external);
  }, [external, same]);
  return [local, setLocal];
}

const sameText = (a: string, b: string): boolean => a === b;
/** Numbers compare by value (`2.` equals `2`); other text compares as typed. */
const sameNumeric = (a: string, b: string): boolean => {
  const na = a.trim();
  const nb = b.trim();
  if (na === nb) return true;
  const isNum = (s: string) => /^-?\d+(\.\d*)?$/.test(s);
  return isNum(na) && isNum(nb) && Number(na) === Number(nb);
};

export function SyncedInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
    value: string;
    onValue(v: string): void;
    numeric?: boolean;
  },
) {
  const { value, onValue, numeric, ...rest } = props;
  const [text, setText] = useSynced(value, numeric ? sameNumeric : sameText);
  return (
    <input
      {...rest}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onValue(e.target.value);
      }}
    />
  );
}

export function SyncedTextarea(
  props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
    value: string;
    onValue(v: string): void;
  },
) {
  const { value, onValue, ...rest } = props;
  const [text, setText] = useSynced(value, sameText);
  return (
    <textarea
      {...rest}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onValue(e.target.value);
      }}
    />
  );
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** A list in a single text control (space/comma/newline separated), e.g. package names or domains. */
export function ListInput(
  props: {
    items: readonly string[];
    onItems(items: string[]): void;
    split(text: string): string[];
    multiline?: boolean;
  } & Omit<
    InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'onChange'
  >,
) {
  const { items, onItems, split, multiline, ...rest } = props;
  const joined = items.join(multiline ? '\n' : ' ');
  const [text, setText] = useState(joined);
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    if (!sameList(split(textRef.current), items)) setText(joined);
  }, [joined, items, split]);
  const change = (v: string) => {
    setText(v);
    onItems(split(v));
  };
  return multiline ? (
    <textarea {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} value={text} onChange={(e) => change(e.target.value)} />
  ) : (
    <input {...(rest as InputHTMLAttributes<HTMLInputElement>)} value={text} onChange={(e) => change(e.target.value)} />
  );
}
