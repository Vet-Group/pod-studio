/**
 * Primary navigation. Slugs, labels and order match `navs` in design/wireframes/index.html, and
 * icons match its `icons`. `task` is the tasks/tasks.json entry that builds the real screen; until
 * then the route renders a placeholder.
 */
export const screens = [
  { slug: 'studio', label: 'Design library', task: 'P1-09' },
  { slug: 'review', label: 'Design review', task: 'P1-10' },
  { slug: 'listing', label: 'Listing content', task: 'P2-02' },
  { slug: 'products', label: 'Products & push', task: 'P2-04' },
  { slug: 'team', label: 'Stores & members', task: 'P1-04' },
  { slug: 'skills', label: 'Skills & operations', task: 'P3-04' },
  { slug: 'niche', label: 'Niche data', task: 'P3-09' },
] as const;

export type Screen = (typeof screens)[number];
export type ScreenSlug = Screen['slug'];

/** Landing screen for `/` and for links back into the app. */
export const HOME_SCREEN: Screen = screens[0];

export function findScreen(slug: string): Screen | undefined {
  return screens.find((s) => s.slug === slug);
}
