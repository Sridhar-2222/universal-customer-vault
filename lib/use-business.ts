import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

export type BusinessInfo = { id: string; name: string; gstin: string | null; role: string | null; book: string | null; error: string | null };
/** The business, my role in it, and its book (created on first open by an owner/admin). */
export function useBusiness(id: string | undefined) {
  const [info, setInfo] = useState<BusinessInfo | null>(null);
  const load = useCallback(async () => {
    if (!id) return;
    const { data: u } = await supabase.auth.getUser();
    const [b, m, bk] = await Promise.all([
      supabase.from("businesses").select("id,name,gstin").eq("id", id).maybeSingle(),
      supabase.from("business_members").select("role").eq("business_id", id).eq("user_id", u.user?.id ?? "").maybeSingle(),
      supabase.rpc("business_book", { p_business: id }),
    ]);
    setInfo({
      id, name: (b.data as { name?: string } | null)?.name ?? "Business", gstin: (b.data as { gstin?: string | null } | null)?.gstin ?? null,
      role: (m.data as { role?: string } | null)?.role ?? null, book: (bk.data as string | null) ?? null,
      error: bk.error ? "The owner or an admin must open the business accounts once before staff can use them." : null,
    });
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const canApprove = info?.role === "owner" || info?.role === "admin";
  return { info, canApprove, reload: load };
}
