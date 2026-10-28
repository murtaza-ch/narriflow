import { Suspense } from "react";
import SocialAccountsLoading from "./loading";
import { SocialAccountsScreen } from "./social-accounts-screen";

// Data-free shell: accounts and plan facts are scoped API queries in the client screen.
export default function SocialAccountsPage() {
	return (
		<Suspense fallback={<SocialAccountsLoading />}>
			<SocialAccountsScreen />
		</Suspense>
	);
}
