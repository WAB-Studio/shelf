// `next-intl/server` refuses to load outside a Server Component render, and the
// harness calls route handlers directly. A translation here is its own key: the
// suites that drive a route assert on status and timing, never on the copy.
export const getTranslations = async (): Promise<(key: string) => string> => (key) => key;
