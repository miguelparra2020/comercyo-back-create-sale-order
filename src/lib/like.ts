// Escapes LIKE metacharacters so a search for "50%" or "a_b" matches literally
// (backslash is Postgres' default LIKE escape character).
export const escapeLike = (term: string) => term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
