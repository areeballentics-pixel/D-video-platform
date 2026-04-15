"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DashboardIndex() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/videos");
  }, [router]);

  return (
    <div className="flex items-center justify-center py-20">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}
