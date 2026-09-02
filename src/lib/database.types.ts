// Tipos do banco. Mantidos à mão e espelhando supabase/migrations/*.sql.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type PriceSource = "nfce" | "precodahora" | "encarte" | "manual";

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; display_name: string | null; created_at: string };
        Insert: { id: string; display_name?: string | null; created_at?: string };
        Update: { id?: string; display_name?: string | null; created_at?: string };
        Relationships: [];
      };
      households: {
        Row: {
          id: string;
          name: string;
          invite_code: string;
          created_by: string;
          created_at: string;
          lat: number | null;
          lng: number | null;
          address: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          invite_code?: string;
          created_by?: string;
          created_at?: string;
          lat?: number | null;
          lng?: number | null;
          address?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          invite_code?: string;
          created_by?: string;
          created_at?: string;
          lat?: number | null;
          lng?: number | null;
          address?: string | null;
        };
        Relationships: [];
      };
      household_members: {
        Row: { household_id: string; user_id: string; role: "owner" | "member"; joined_at: string };
        Insert: { household_id: string; user_id: string; role?: "owner" | "member"; joined_at?: string };
        Update: { household_id?: string; user_id?: string; role?: "owner" | "member"; joined_at?: string };
        Relationships: [];
      };
      lists: {
        Row: { id: string; household_id: string; name: string; is_default: boolean; created_at: string };
        Insert: { id?: string; household_id: string; name?: string; is_default?: boolean; created_at?: string };
        Update: { id?: string; household_id?: string; name?: string; is_default?: boolean; created_at?: string };
        Relationships: [];
      };
      list_items: {
        Row: {
          id: string;
          list_id: string;
          name: string;
          quantity: number;
          unit: string | null;
          note: string | null;
          checked: boolean;
          checked_at: string | null;
          checked_by: string | null;
          added_by: string;
          created_at: string;
          updated_at: string;
          product_id: string | null;
          gtin: string | null;
          normalized_name: string;
          category: string | null;
        };
        Insert: {
          id?: string;
          list_id: string;
          name: string;
          quantity?: number;
          unit?: string | null;
          note?: string | null;
          checked?: boolean;
          checked_at?: string | null;
          checked_by?: string | null;
          added_by?: string;
          created_at?: string;
          updated_at?: string;
          product_id?: string | null;
          gtin?: string | null;
          category?: string | null;
        };
        Update: {
          id?: string;
          list_id?: string;
          name?: string;
          quantity?: number;
          unit?: string | null;
          note?: string | null;
          checked?: boolean;
          checked_at?: string | null;
          checked_by?: string | null;
          added_by?: string;
          created_at?: string;
          updated_at?: string;
          product_id?: string | null;
          gtin?: string | null;
          category?: string | null;
        };
        Relationships: [];
      };
      stores: {
        Row: {
          id: string;
          cnpj: string | null;
          name: string;
          address: string | null;
          city: string | null;
          lat: number | null;
          lng: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          cnpj?: string | null;
          name: string;
          address?: string | null;
          city?: string | null;
          lat?: number | null;
          lng?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          cnpj?: string | null;
          name?: string;
          address?: string | null;
          city?: string | null;
          lat?: number | null;
          lng?: number | null;
          created_at?: string;
        };
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          gtin: string | null;
          name: string;
          normalized_name: string;
          brand: string | null;
          category: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          gtin?: string | null;
          name: string;
          brand?: string | null;
          category?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          gtin?: string | null;
          name?: string;
          brand?: string | null;
          category?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      receipts: {
        Row: {
          id: string;
          household_id: string;
          store_id: string;
          access_key: string;
          issued_at: string | null;
          total: number | null;
          item_count: number | null;
          source_url: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          household_id: string;
          store_id: string;
          access_key: string;
          issued_at?: string | null;
          total?: number | null;
          item_count?: number | null;
          source_url?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          household_id?: string;
          store_id?: string;
          access_key?: string;
          issued_at?: string | null;
          total?: number | null;
          item_count?: number | null;
          source_url?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      receipt_items: {
        Row: {
          id: string;
          receipt_id: string;
          product_id: string | null;
          description: string;
          gtin: string | null;
          quantity: number;
          unit: string | null;
          unit_price: number;
          total: number;
          position: number;
        };
        Insert: {
          id?: string;
          receipt_id: string;
          product_id?: string | null;
          description: string;
          gtin?: string | null;
          quantity?: number;
          unit?: string | null;
          unit_price: number;
          total: number;
          position?: number;
        };
        Update: {
          id?: string;
          receipt_id?: string;
          product_id?: string | null;
          description?: string;
          gtin?: string | null;
          quantity?: number;
          unit?: string | null;
          unit_price?: number;
          total?: number;
          position?: number;
        };
        Relationships: [];
      };
      price_observations: {
        Row: {
          id: string;
          household_id: string;
          store_id: string;
          product_id: string | null;
          receipt_item_id: string | null;
          gtin: string | null;
          description: string;
          normalized_name: string;
          price: number;
          unit: string | null;
          observed_at: string;
          valid_until: string | null;
          source: PriceSource;
          created_at: string;
        };
        Insert: {
          id?: string;
          household_id: string;
          store_id: string;
          product_id?: string | null;
          receipt_item_id?: string | null;
          gtin?: string | null;
          description: string;
          price: number;
          unit?: string | null;
          observed_at: string;
          valid_until?: string | null;
          source: PriceSource;
          created_at?: string;
        };
        Update: {
          id?: string;
          household_id?: string;
          store_id?: string;
          product_id?: string | null;
          receipt_item_id?: string | null;
          gtin?: string | null;
          description?: string;
          price?: number;
          unit?: string | null;
          observed_at?: string;
          valid_until?: string | null;
          source?: PriceSource;
          created_at?: string;
        };
        Relationships: [];
      };
      item_matches: {
        Row: {
          id: string;
          household_id: string;
          item_key: string;
          description_key: string;
          gtin: string | null;
          is_match: boolean;
          source: "llm" | "user";
          reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          household_id: string;
          item_key: string;
          description_key: string;
          gtin?: string | null;
          is_match: boolean;
          source: "llm" | "user";
          reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          household_id?: string;
          item_key?: string;
          description_key?: string;
          gtin?: string | null;
          is_match?: boolean;
          source?: "llm" | "user";
          reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      item_categories: {
        Row: { item_key: string; category: string; source: "llm" | "user"; updated_at: string };
        Insert: { item_key: string; category: string; source: "llm" | "user"; updated_at?: string };
        Update: { item_key?: string; category?: string; source?: "llm" | "user"; updated_at?: string };
        Relationships: [];
      };
      product_suggestions: {
        Row: { term_key: string; gtins: string[]; fetched_at: string };
        Insert: { term_key: string; gtins?: string[]; fetched_at?: string };
        Update: { term_key?: string; gtins?: string[]; fetched_at?: string };
        Relationships: [];
      };
      shopping_sessions: {
        Row: { id: string; household_id: string; list_id: string | null; store_id: string | null; store_name: string | null; started_at: string; finished_at: string | null; total: number; created_by: string | null; created_at: string };
        Insert: { id?: string; household_id: string; list_id?: string | null; store_id?: string | null; store_name?: string | null; started_at?: string; finished_at?: string | null; total?: number; created_by?: string | null; created_at?: string };
        Update: { id?: string; household_id?: string; list_id?: string | null; store_id?: string | null; store_name?: string | null; started_at?: string; finished_at?: string | null; total?: number; created_by?: string | null; created_at?: string };
        Relationships: [];
      };
      shopping_session_items: {
        Row: { id: string; session_id: string; list_item_id: string | null; product_id: string | null; gtin: string | null; description: string; quantity: number; unit_price: number; total: number; scanned: boolean; created_at: string };
        Insert: { id?: string; session_id: string; list_item_id?: string | null; product_id?: string | null; gtin?: string | null; description: string; quantity?: number; unit_price: number; scanned?: boolean; created_at?: string };
        Update: { id?: string; session_id?: string; list_item_id?: string | null; product_id?: string | null; gtin?: string | null; description?: string; quantity?: number; unit_price?: number; scanned?: boolean; created_at?: string };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_household_member: { Args: { hid: string }; Returns: boolean };
      create_household: { Args: { p_name: string }; Returns: string };
      join_household: { Args: { p_code: string }; Returns: string };
      normalize_name: { Args: { "": string }; Returns: string };
      best_prices: {
        Args: { p_list_id: string; p_max_age_hours?: number };
        Returns: {
          list_item_id: string;
          item_name: string;
          store_id: string;
          store_name: string;
          store_lat: number | null;
          store_lng: number | null;
          price: number;
          description: string;
          gtin: string | null;
          observed_at: string;
          source: PriceSource;
          match_kind: "gtin" | "product" | "name" | "llm" | "user";
          score: number;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
export type ListItem = Tables<"list_items">;
export type Household = Tables<"households">;
export type List = Tables<"lists">;
export type Profile = Tables<"profiles">;
export type Store = Tables<"stores">;
export type Product = Tables<"products">;
export type Receipt = Tables<"receipts">;
export type ReceiptItem = Tables<"receipt_items">;
export type PriceObservation = Tables<"price_observations">;
export type ItemMatch = Tables<"item_matches">;
export type MatchKind = BestPriceRow["match_kind"];
export type ShoppingSession = Tables<"shopping_sessions">;
export type ShoppingSessionItem = Tables<"shopping_session_items">;

/** Contrato de POST /api/produtos/sugerir. */
export type ProductSuggestion = {
  gtin: string;
  descricao: string;
  categoria: string | null;
  origem: "local" | "precodahora";
  ultimaCompra?: { loja: string; preco: number; data: string };
};

/** Contrato de GET /api/produtos/[gtin]. */
export type ProductLookup = {
  produto: { gtin: string; descricao: string; categoria: string | null } | null;
  precoSugerido: { preco: number; loja: string; fonte: PriceSource; data: string } | null;
};
export type BestPriceRow = Database["public"]["Functions"]["best_prices"]["Returns"][number];

/** Formato de resultado do Preço da Hora (contrato de /api/precos/buscar). */
export type PdhResult = {
  descricao: string;
  gtin: string | null;
  preco: number;
  unidade: string | null;
  data: string;
  loja: {
    nome: string;
    cnpj: string | null;
    endereco: string | null;
    cidade: string | null;
    lat: number | null;
    lng: number | null;
    distanciaKm: number | null;
  };
};
