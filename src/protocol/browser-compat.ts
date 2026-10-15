/** Module names shared by the browser registry and presentation builder. */
export const canonicalBrowserModule = (name: string): string => name.replace(/^@mariozechner\//, '@earendil-works/').replace(/^node:/, '');
