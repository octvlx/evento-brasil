-- Categorias padrão de evento. Antes existiam só no seed de desenvolvimento, então em
-- produção o select "Categoria" do formulário de evento ficava vazio e não dava para
-- criar evento. Mesma lista e ordem de prisma/seed.ts; não altera categorias existentes.
INSERT INTO "EventCategory" ("id", "slug", "name", "sortOrder") VALUES
  ('cat_shows-e-musica', 'shows-e-musica', 'Shows e música', 0),
  ('cat_festas', 'festas', 'Festas', 1),
  ('cat_teatro', 'teatro', 'Teatro e espetáculos', 2),
  ('cat_stand-up', 'stand-up', 'Stand-up', 3),
  ('cat_festivais', 'festivais', 'Festivais', 4),
  ('cat_gastronomia', 'gastronomia', 'Gastronomia', 5),
  ('cat_esportes', 'esportes', 'Esportes', 6),
  ('cat_cursos-e-workshops', 'cursos-e-workshops', 'Cursos e workshops', 7),
  ('cat_infantil', 'infantil', 'Infantil', 8),
  ('cat_congressos', 'congressos', 'Congressos e palestras', 9)
ON CONFLICT ("slug") DO NOTHING;
