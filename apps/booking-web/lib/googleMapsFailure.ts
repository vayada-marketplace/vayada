/** Google calls window.gm_authFailure when it refuses the Maps key (a hotel on its own domain, VAY-2328). Every
 * map on the page listens through this one handler: maps that each set and restore it can drop each other's. */
const listeners = new Set<() => void>();
let installed = false;

export function onGoogleAuthFailure(listener: () => void): () => void {
  if (!installed) {
    installed = true;
    const googleWindow = window as Window & { gm_authFailure?: () => void };
    const previous = googleWindow.gm_authFailure;
    googleWindow.gm_authFailure = () => {
      previous?.();
      listeners.forEach((notify) => notify());
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
