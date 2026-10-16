/** A random ID for this browser, kept in localStorage. A guest window gets a new one each time. */
export function getDeviceId(): string {
	const KEY = 'sb-device-id';
	try {
		let id = localStorage.getItem(KEY);
		if (!id) {
			id = crypto.randomUUID();
			localStorage.setItem(KEY, id);
		}
		return id;
	} catch {
		return crypto.randomUUID();
	}
}
