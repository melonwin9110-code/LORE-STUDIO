import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lore Studio — мастерская миров",
  description: "Создавайте вселенные, переплетайте судьбы и сохраняйте историю. Автор проекта — ElpisHeart.",
  authors: [{ name: "ElpisHeart" }],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" suppressHydrationWarning><body>{children}</body></html>;
}
