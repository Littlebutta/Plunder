/**
 * Little ink drawings for the upgrades: plain SVG strokes in the colour of the
 * text around them, drawn on a 24 x 24 grid. No emoji.
 */
const ICONS: Record<string, string> = {
  // a spyglass
  nest: '<path d="M3 15l12-7 2 4-12 7z"/><path d="M15 8l3-2 2 4-3 2"/><path d="M8 17l-2 4M10 16l2 5"/>',
  // a long cannon barrel on its carriage
  barrels: '<path d="M2 10h15l3-1v4l-3-1H2z"/><circle cx="7" cy="16" r="2.5"/><circle cx="14" cy="16" r="2.5"/><path d="M20 11h2"/>',
  // a cannonball and a stopwatch hand
  drill: '<circle cx="12" cy="13" r="8"/><path d="M12 13V8M12 13l4 2"/><path d="M10 3h4M12 3v2"/>',
  // a swivel gun on its post
  swivel: '<path d="M6 9h11l2-1v4l-2-1H6z"/><path d="M11 11v5M8 21h6l-3-5z"/><path d="M4 6a8 8 0 0 1 4-2M20 6a8 8 0 0 0-4-2"/>',
  // stacked oak planks
  oak: '<path d="M3 6h18v4H3zM3 10h18v4H3zM3 14h18v4H3z"/><path d="M8 6v4M15 10v4M10 14v4"/>',
  // a hammer
  carpenter: '<path d="M4 20l9-9"/><path d="M11 5l5-2 5 5-2 2-3-1-3 3-3-3 3-3z"/>',
  // a saw
  shipwright: '<path d="M3 15l14-10 3 3-14 10z"/><path d="M6 13l1 2M9 11l1 2M12 9l1 2M15 7l1 2"/><path d="M17 5l3-2 1 4"/>',
  // a hull with copper below the waterline
  copper: '<path d="M2 9h20l-3 8H5z"/><path d="M3.5 13h17" stroke-dasharray="2 2"/><path d="M12 9V3l5 4h-5"/>',
  // a full sail
  canvas: '<path d="M7 3v18"/><path d="M7 4c8 2 11 6 11 9s-3 6-11 7"/><path d="M2 8h3M1 12h4M2 16h3"/>',
  // a ship's wheel
  rudder: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>',
  // a stack of coins
  tax: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v4c0 1.4 3 2.5 7 2.5s7-1.1 7-2.5V6"/><path d="M5 10v4c0 1.4 3 2.5 7 2.5s7-1.1 7-2.5v-4"/><path d="M5 14v4c0 1.4 3 2.5 7 2.5s7-1.1 7-2.5v-4"/>',
  // a barrel washed up
  scavenger: '<path d="M7 4h10c1.5 4 1.5 12 0 16H7C5.5 16 5.5 8 7 4z"/><path d="M6 9h12M6 15h12"/><path d="M1 21c2-1 3 1 5 0M18 21c2-1 3 1 5 0"/>',
  // a powder keg with a fuse
  monkeys: '<path d="M6 8h12v12H6z"/><path d="M6 12h12M6 16h12"/><path d="M12 8c0-3 2-4 4-5"/><path d="M17 1l1 2 2 0-2 1"/>',
  // a rolled charter with a seal
  charter: '<path d="M5 5h12a2 2 0 0 1 0 4H5a2 2 0 0 1 0-4z"/><path d="M5 9v9a2 2 0 0 0 2 2h11V9"/><path d="M9 13h6M9 16h4"/><circle cx="17" cy="18" r="2"/>',
};

/** An upgrade's icon as inline SVG (sized by the surrounding CSS, coloured by `currentColor`). */
export function upgradeIcon(id: string, size = 24): string {
  const body = ICONS[id] ?? '<circle cx="12" cy="12" r="8"/>';
  return `<svg class="up-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
