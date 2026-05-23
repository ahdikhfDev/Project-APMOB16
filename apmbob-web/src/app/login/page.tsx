"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const router = useRouter();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      router.push("/");
    } catch (err: any) {
      setError(err.code === "auth/invalid-credential" ? "Email atau password salah" : err.message || "Gagal login");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[#f4eedd]" style={{ backgroundImage: "radial-gradient(#000 1px,transparent 1px)", backgroundSize: "20px 20px" }}>
      <form onSubmit={handleSubmit} className="w-full max-w-sm neo-border bg-white p-8 shadow-[8px_8px_0px_0px_#000]">
        <div className="text-center mb-6">
          <div className="bg-[#c6f91f] w-16 h-16 mx-auto flex items-center justify-center border-2 border-black shadow-[3px_3px_0px_0px_#000]">
            <i className="fa-solid fa-satellite-dish text-2xl text-black"></i>
          </div>
          <h1 className="text-3xl font-bold tracking-tighter uppercase mt-3">LacakIn</h1>
          <p className="text-xs font-bold uppercase tracking-widest text-gray-600 mt-1">Masuk ke Dashboard</p>
        </div>

        {error && (
          <div className="bg-[#ff4d4d] border-2 border-black p-3 mb-4 text-center">
            <p className="text-black text-xs font-bold uppercase">{error}</p>
          </div>
        )}

        <div className="flex flex-col gap-4">
          <div>
            <label className="text-xs font-bold uppercase block mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full border-2 border-black p-3 text-sm font-bold uppercase bg-[#f4eedd] focus:outline-none focus:shadow-[3px_3px_0px_0px_#000] focus:translate-x-[-2px] focus:translate-y-[-2px] transition-all"
              placeholder="email@contoh.com"
            />
          </div>
          <div>
            <label className="text-xs font-bold uppercase block mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full border-2 border-black p-3 text-sm font-bold bg-[#f4eedd] focus:outline-none focus:shadow-[3px_3px_0px_0px_#000] focus:translate-x-[-2px] focus:translate-y-[-2px] transition-all"
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#c6f91f] border-2 border-black p-3 font-extrabold text-sm uppercase tracking-wider shadow-[4px_4px_0px_0px_#000] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            {loading ? "Memproses..." : "Masuk"}
          </button>
        </div>
      </form>
    </div>
  );
}
