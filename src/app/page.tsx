import { connection } from "next/server";
import HomeClient from "./home-client";

export default async function Page() {
  await connection();
  return <HomeClient />;
}
