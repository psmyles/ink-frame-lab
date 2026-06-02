export const state = {
  queue: [],
  selectedId: null,
  viewTab: 'image',     // 'image' | '3d'
  resolution: { w: 800, h: 480 },
  aspectRatio: 800 / 480,
  diagonal: 7.3,
  isProcessing: false,
};

export function getSelected() {
  return state.queue.find(q => q.id === state.selectedId) || null;
}

export function createItem(file) {
  return {
    id: Math.random().toString(36).slice(2),
    file,
    name: file.name,
    status: 'pending',       // 'pending' | 'processing' | 'done' | 'error'
    sourceCanvas: null,
    ditheredCanvas: null,
    deviceCanvas: null,
    cropRect: null,          // { x, y, w, h } in source image pixels
  };
}
