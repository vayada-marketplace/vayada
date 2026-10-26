// Vitest stand-in for next/font/local, which only works inside Next's compiler. Apps whose unit
// tests import a component that uses these fonts alias next/font/local to this file.
export default function localFont() {
  return { className: "", variable: "", style: { fontFamily: "'next-font-local'" } };
}
