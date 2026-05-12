"use client";

import { createClient } from "../../lib/supabase-client";
import { useRouter } from "@/lib/next-shim";

export function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    // Use window.location for a hard redirect to clear all client state
    window.location.href = "/whatsapp/login";
  }

  return (
    <button
      onClick={handleSignOut}
      className="text-sm text-text-tertiary transition-colors duration-150 hover:text-wa-green"
    >
      Sign out
    </button>
  );
}
