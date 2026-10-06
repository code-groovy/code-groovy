export interface SourceRefreshPlan {
	removed: string[];
	toIndex: Set<string>;
}

export function planSourceRefresh(
	listed: string[],
	cachedKeys: Iterable<string>,
	changed: ReadonlySet<string>,
	fullRefresh: boolean
): SourceRefreshPlan {
	const cached = [...cachedKeys];
	const listedSet = new Set(listed);
	const cachedSet = new Set(cached);
	return {
		removed: fullRefresh ? cached : cached.filter(filePath => !listedSet.has(filePath)),
		toIndex: new Set(listed.filter(filePath => fullRefresh || changed.has(filePath) || !cachedSet.has(filePath)))
	};
}
