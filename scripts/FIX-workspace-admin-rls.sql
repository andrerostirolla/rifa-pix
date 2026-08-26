-- FIX: ADM não conseguia salvar/baixar o workspace ("Falha ao salvar" / "Falha ao baixar").
--
-- Causa: na policy de workspaces, o "id" dentro do subselect era resolvido como
-- workspace_admins.id (a tabela do FROM interno), e não como workspaces.id.
-- Resultado: a comparação virava a.workspace_id = a.id, que nunca é verdadeira,
-- então todo ADM que não é o dono ficava sem permissão de select/update.
--
-- Rode este script inteiro no SQL Editor do Supabase.

drop policy if exists "workspaces_owner_all" on public.workspaces;
drop policy if exists "workspaces_admins_all" on public.workspaces;

create policy "workspaces_admins_all"
  on public.workspaces
  for all
  using (
    auth.uid() = public.workspaces.owner_id
    or exists (
      select 1
      from public.workspace_admins a
      where a.workspace_id = public.workspaces.id
        and a.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = public.workspaces.owner_id
    or exists (
      select 1
      from public.workspace_admins a
      where a.workspace_id = public.workspaces.id
        and a.user_id = auth.uid()
    )
  );

-- Conferência: deve listar a equipe para o ADM logado.
-- select id, name, access_code from public.workspaces;
