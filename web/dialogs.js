export function dismissOnBackdrop(dialog) {
  const outside = event => {
    const box = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  };
  let startedOutside = false;
  dialog.addEventListener('pointerdown', event => { startedOutside = event.button === 0 && outside(event); });
  dialog.addEventListener('click', event => {
    if (startedOutside && outside(event)) dialog.close();
    startedOutside = false;
  });
  dialog.addEventListener('close', () => { startedOutside = false; });
}
