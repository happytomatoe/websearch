export function isObject(cause: unknown): cause is object {
	return typeof cause === "object" && cause !== null;
}
