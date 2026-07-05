import { useEffect, useState } from "react";
import { LoginScreen } from "@/features/auth/LoginScreen";
import { RoomsScreen } from "@/features/rooms/RoomsScreen";
import { watchDeepLinks } from "@/lib/deepLink";
import { tryRestoreSession, type LoginResponse } from "@/lib/matrix";

function App() {
  const [session, setSession] = useState<LoginResponse | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [deepLinkRoomId, setDeepLinkRoomId] = useState<string | null>(null);

  useEffect(() => {
    tryRestoreSession()
      .then(setSession)
      .catch(console.error)
      .finally(() => setRestoring(false));
  }, []);

  useEffect(() => {
    // Held here (above the login gate) so a deep link received before sign-in
    // completes is applied once RoomsScreen mounts, not dropped.
    const unlisten = watchDeepLinks(setDeepLinkRoomId);
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, []);

  if (restoring) {
    return <div className="flex min-h-screen items-center justify-center bg-background" />;
  }

  if (!session) {
    return <LoginScreen onSignedIn={setSession} />;
  }

  return (
    <RoomsScreen
      currentUserId={session.user_id}
      deepLinkRoomId={deepLinkRoomId}
      onDeepLinkConsumed={() => setDeepLinkRoomId(null)}
    />
  );
}

export default App;
