// Tipos do banco. Mantidos à mão e espelhando supabase/migrations/0001_init.sql.
// Quando o schema mudar, atualizar aqui (ou gerar via `supabase gen types`).

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

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
        Row: { id: string; name: string; invite_code: string; created_by: string; created_at: string };
        Insert: { id?: string; name: string; invite_code?: string; created_by?: string; created_at?: string };
        Update: { id?: string; name?: string; invite_code?: string; created_by?: string; created_at?: string };
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
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_household_member: { Args: { hid: string }; Returns: boolean };
      create_household: { Args: { p_name: string }; Returns: string };
      join_household: { Args: { p_code: string }; Returns: string };
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
