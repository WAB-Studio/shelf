// `refresh` and `revalidatePath` throw outside a request, and the harness calls
// server actions directly. Cache invalidation has nothing to invalidate here.
export const refresh = (): void => {};
export const revalidatePath = (): void => {};
