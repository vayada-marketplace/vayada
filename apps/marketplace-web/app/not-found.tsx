import Home from "./page";

// Unknown routes are forwarded by next.config.js; this only renders when that is bypassed.
export default function NotFound() {
  return <Home />;
}
