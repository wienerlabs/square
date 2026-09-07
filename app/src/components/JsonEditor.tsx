"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import { errorLine, tokenize, type TokenKind } from "@/lib/json-editor";
import { inputClass } from "./Field";

const colors: Record<TokenKind, string> = {
  key: "text-carbon font-medium",
  string: "text-sky",
  number: "text-amber",
  literal: "text-magenta",
  punct: "text-ash",
  space: "",
  other: "text-magenta underline decoration-magenta/50",
};

export function JsonEditor({
  id,
  value,
  onChange,
  error,
  placeholder,
  minHeight = 240,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  placeholder?: string;
  minHeight?: number;
}) {
  const mirror = useRef<HTMLPreElement>(null);
  const [focused, setFocused] = useState(false);
  const lines = useMemo(() => value.split("\n"), [value]);
  const bad = useMemo(() => errorLine(error, value), [error, value]);
  const gutter = Math.max(2, String(lines.length).length);

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    const target = event.currentTarget;
    if (mirror.current) {
      mirror.current.scrollTop = target.scrollTop;
      mirror.current.scrollLeft = target.scrollLeft;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const next = `${value.slice(0, start)}  ${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      target.selectionStart = start + 2;
      target.selectionEnd = start + 2;
    });
  }

  const shared = "m-0 whitespace-pre font-mono text-[13px] leading-6";
  const padLeft = `${gutter + 3.5}ch`;

  return (
    <div
      className={`relative overflow-hidden rounded-lg border bg-mist ${focused ? "border-fog" : "border-transparent"}`}
      style={{ minHeight }}
    >
      <pre ref={mirror} aria-hidden="true" className={`${shared} pointer-events-none absolute inset-0 overflow-hidden py-2.5 pr-3.5`} style={{ paddingLeft: padLeft }}>
        {lines.map((line, index) => {
          const number = index + 1;
          const isBad = bad === number;
          return (
            <span key={number} className={`relative block ${isBad ? "bg-magenta/10" : ""}`}>
              <span
                aria-hidden="true"
                className={`absolute left-0 select-none text-right ${isBad ? "text-magenta" : "text-ash"}`}
                style={{ width: `${gutter}ch`, marginLeft: `calc(-1 * ${padLeft} + 1ch)` }}
              >
                {number}
              </span>
              {line.length === 0 ? " " : tokenize(line).map((token, tokenIndex) => (
                <span key={tokenIndex} className={colors[token.kind]}>
                  {token.text}
                </span>
              ))}
            </span>
          );
        })}
      </pre>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        spellCheck={false}
        wrap="off"
        className={`${inputClass} ${shared} relative block w-full resize-y border-0 bg-transparent py-2.5 pr-3.5 text-transparent caret-carbon placeholder:text-ash focus:border-transparent`}
        style={{ paddingLeft: padLeft, minHeight, WebkitTextFillColor: "transparent" }}
      />
    </div>
  );
}
