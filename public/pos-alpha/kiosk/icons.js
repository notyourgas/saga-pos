const paths = {
  "arrow-left": '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  "arrow-right": '<path d="M6.75 12h10.5M13.25 8l4 4-4 4"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  bag: '<path d="M6 2l1 4h10l1-4"/><path d="M5 6h14l1 15H4L5 6z"/><path d="M9 10a3 3 0 0 0 6 0"/>',
  coffee: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>',
  star: '<polygon points="12 2 15 8.5 22 9.3 17 14 18.4 21 12 17.5 5.6 21 7 14 2 9.3 9 8.5 12 2"/>',
  sparkles: '<path d="M12 3l1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
  bubbles: '<circle cx="8" cy="15" r="5"/><circle cx="16.5" cy="8" r="3.5"/><circle cx="18" cy="18" r="2"/>',
  leaf: '<path d="M20 4C11 4 5 9 5 16c0 2 1 4 3 4 7 0 12-7 12-16z"/><path d="M5 20c3-5 7-8 12-11"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M8 6V4h8v2M19 6l-1 15H6L5 6"/><line x1="10" y1="10" x2="10" y2="17"/><line x1="14" y1="10" x2="14" y2="17"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  scan: '<path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3"/><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9.5 12h5"/>',
};

export function icon(name, className = "") {
  return `<svg class="icon ${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.alert}</svg>`;
}
