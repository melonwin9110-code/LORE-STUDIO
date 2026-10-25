import type { PoolClient } from "pg";
import { createEntity, createProject, createWorld, projectAccess } from "./repository";
import { createDemoAtlas } from "./map-demo";

export async function createDemo(client: PoolClient, userId: string) {
  // Concurrent clicks must not create two copies. Each account gets its own private universe.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`demo:${userId}`]);
  const existing = await client.query<{ id: string }>("SELECT id FROM projects WHERE owner_id=$1 AND is_demo", [userId]);
  if (existing.rows[0]) return projectAccess(client, userId, existing.rows[0].id);
  const project = await createProject(client, userId, "Элирия", "Мир шепчущих лесов, древних династий и света двух лун. Демонстрационная вселенная Lore Studio.", true);
  const world = await createWorld(client, userId, project.id, "Элирия", "Земли между Серебряным морем и Хребтом Рассвета. Главная история, лето 1248 года.");
  const liora = await createEntity(client, userId, world.id, "characters", {
    name: "Лиора Эльвейн", title: "Хранительница Серебряного леса", species: "Эльф", gender: "Женский", birthYear: 1120,
    appearance: "Серебристые волосы, янтарные глаза и плащ цвета вечернего леса.",
    personality: "Внимательна к чужим историям, сдержанна, предана своему слову.",
    biography: "Лиора выросла среди хранителей Серебряного леса. После Великого затмения она первой услышала голос древнего древа и отправилась искать утраченную Книгу рассвета.",
    motivation: "Сохранить память леса и примирить старые королевства.", abilities: "Язык деревьев, стрельба из лука, знание древних рун.",
    secrets: "Она помнит сон о третьей луне, которой никто никогда не видел.", status: "canon",
  });
  const aeren = await createEntity(client, userId, world.id, "characters", {
    name: "Аэрен Вальд", title: "Капитан северной стражи", species: "Человек", gender: "Мужской", birthYear: 1214,
    biography: "Сын картографа из прибрежного города. После распада Северного союза собрал отряд добровольцев, чтобы защитить дороги между королевствами.",
    personality: "Прямолинеен и терпелив. Верит людям больше, чем знаменам.", motivation: "Открыть безопасный путь через Хребет Рассвета.",
    abilities: "Тактика, морская навигация, владение мечом.", status: "canon",
  });
  const mira = await createEntity(client, userId, world.id, "characters", {
    name: "Мира Солвей", title: "Летописец двух лун", species: "Человек", gender: "Женский", birthYear: 1221,
    biography: "Мира хранит летописи Обсерватории. Найденная ею звёздная карта связывает исчезновение Книги рассвета с Великим затмением.",
    personality: "Любознательна, иронична и настойчива.", motivation: "Найти правду о Великом затмении.", status: "draft",
  });
  await createEntity(client, userId, world.id, "relations", {
    fromId: liora.id, toId: aeren.id, kind: "Союз", mutual: true, startYear: 1246,
    description: "Заключили союз ради защиты Серебряного леса и торговых дорог.",
  });
  await createEntity(client, userId, world.id, "relations", {
    fromId: mira.id, toId: liora.id, kind: "Дружба", mutual: true, startYear: 1247,
    description: "Общая экспедиция превратила осторожное знакомство в доверие.",
  });
  await createEntity(client, userId, world.id, "events", {
    name: "Великое затмение", type: "Астрономическое явление", startYear: 1200,
    description: "Две луны одновременно скрыли солнце. Серебряный лес впервые за тысячу лет погрузился в тишину.", characterIds: [liora.id], status: "canon",
  });
  const treaty = await createEntity(client, userId, world.id, "events", {
    name: "Договор у Серебряного древа", type: "Союз", startYear: 1246,
    description: "Хранители леса и северная стража договорились защищать пограничные земли вместе.", characterIds: [liora.id, aeren.id], status: "canon",
  });
  const expedition = await createEntity(client, userId, world.id, "events", {
    name: "Экспедиция к Хребту Рассвета", type: "Путешествие", startYear: 1248,
    description: "Трое спутников отправляются по следам утраченной Книги рассвета. Чем завершится путешествие — решать вам.", characterIds: [liora.id, aeren.id, mira.id], status: "draft",
  });
  await createDemoAtlas(client, userId, world.id, treaty.id, expedition.id);
  return project;
}
