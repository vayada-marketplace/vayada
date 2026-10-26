import { Fragment, type ReactNode } from "react";

/**
 * A translated sentence with links or bold names inside: "I accept the {terms} and the {dpa} …". Each
 * language keeps its own word order; the parts fill their {placeholders}, and unknown ones stay as text.
 */
export function fillTemplate(template: string, parts: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/).map((piece, index) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    const part = name !== undefined && Object.hasOwn(parts, name) ? parts[name] : piece;
    return <Fragment key={index}>{part}</Fragment>;
  });
}
