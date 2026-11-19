/**
 * The product name lives here and nowhere else.
 *
 * This is the only source file allowed to contain the literal name
 * (`pnpm check:product-name` enforces it). Everything user-facing, every file
 * name and every URL must derive from these constants, so the name can change
 * in one place.
 */
export const PRODUCT_NAME = 'Probin';

/** Lower-case form for file names, URLs and identifiers. */
export const PRODUCT_SLUG = PRODUCT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** The service manifest the skill writes into each customer repository. */
export const MANIFEST_FILENAME = `${PRODUCT_SLUG}.yaml`;
