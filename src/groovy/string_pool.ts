const internPool = new Map<string, string>();

export function intern(value: string): string {
	const pooled = internPool.get(value);
	if (pooled !== undefined) {
		return pooled;
	}
	const copy = Buffer.from(value, 'utf8').toString('utf8');
	internPool.set(copy, copy);
	return copy;
}
