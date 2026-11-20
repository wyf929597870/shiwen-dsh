// Capture on mousedown-preserving controls before focus moves away from the passage.
export function canvasPassage(container){
  const selection=window.getSelection();
  if(!container||!selection||selection.isCollapsed||!container.contains(selection.anchorNode)||!container.contains(selection.focusNode))return '';
  return selection.toString().trim();
}
