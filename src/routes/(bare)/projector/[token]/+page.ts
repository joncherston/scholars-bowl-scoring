export const ssr = false;

export function load({ params }) {
	return { token: params.token };
}
