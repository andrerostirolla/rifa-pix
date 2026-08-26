-- Corrige "id" ambíguo na policy de workspaces: dentro do subselect ele era
-- resolvido como workspace_admins.id, deixando ADM auxiliar sem select/update.

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
