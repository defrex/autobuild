/** Real-browser proof for repository forms and the extended answer composer. */
import { strict as assert } from 'node:assert'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { validateRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import type { BuildStore } from '../../../packages/core/src/store/types'
import type { ExtendedBrowserFixture } from './browser-extended-seed'

interface Driver {
  scripts(enabled: boolean): Promise<void>
  navigate(url: string): Promise<void>
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  html(): Promise<string>
  evaluate(source: string): Promise<unknown>
}
export async function runExtendedBrowserProof(options: {
  fixtures: ExtendedBrowserFixture[]
  store: BuildStore
  origin: string
  driver: Driver
}) {
  const { store, driver } = options
  const evidence: unknown[] = []
  for (const fixture of options.fixtures) {
    await driver.scripts(fixture.mode === 'js')
    const beforeBuild = (await store.getEvents(fixture.build)).length
    const beforeRepository = (await store.getRepoEvents(fixture.project)).length
    const path = fixture.slug ? `/dashboard/builds/${fixture.slug}` : '/'
    await driver.navigate(
      `${options.origin}${path}?${new URLSearchParams({ project: fixture.project })}`,
    )
    let ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      const html = await driver.html()
      const expectedHeading = fixture.slug || 'Builds'
      if (
        html.includes(`>${expectedHeading}</h1>`) &&
        html.includes(`name="project" value="${fixture.project}"`) &&
        (fixture.mode === 'nojs' || (await driver.evaluate(`document.readyState==='complete'`)))
      ) {
        ready = true
        break
      }
      await Bun.sleep(30)
    }
    assert.ok(ready, `${fixture.mode} ${fixture.action}: page did not load`)
    if (fixture.mode === 'js') await driver.evaluate('window.__extendedDocument=document')
    if (fixture.ceiling) await driver.type('#answer-ceiling', fixture.ceiling)
    if (fixture.text) await driver.type('#answer-body', fixture.text)
    await driver.click(`button[value="${fixture.button}"]`)
    let buildDelta = (await store.getEvents(fixture.build)).slice(beforeBuild)
    let repositoryDelta = (await store.getRepoEvents(fixture.project)).slice(beforeRepository)
    for (let attempt = 0; attempt < 150; attempt++) {
      buildDelta = (await store.getEvents(fixture.build)).slice(beforeBuild)
      repositoryDelta = (await store.getRepoEvents(fixture.project)).slice(beforeRepository)
      if (
        buildDelta.length >= fixture.expectedBuildTypes.length &&
        repositoryDelta.length >= fixture.expectedRepositoryTypes.length
      )
        break
      await Bun.sleep(30)
    }
    const label = `${fixture.mode} ${fixture.action}`
    assert.deepEqual(
      buildDelta.map((e) => e.type),
      fixture.expectedBuildTypes,
      `${label}: ordered build facts; ${(await driver.html()).match(/<p[^>]*data-control-error[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? 'no inline refusal'}`,
    )
    assert.deepEqual(
      repositoryDelta.map((e) => e.type),
      fixture.expectedRepositoryTypes,
      `${label}: ordered repository facts`,
    )
    buildDelta.forEach(validateEventWrite)
    repositoryDelta.forEach(validateRepositoryEventWrite)
    assert.deepEqual(
      buildDelta.map((event) => event.actor),
      fixture.expectedBuildActors,
      `${label}: source actor sequence`,
    )
    for (const event of repositoryDelta) {
      assert.deepEqual(
        event.actor,
        { kind: 'human', user: 'operator@example.com' },
        `${label}: signed-in identity`,
      )
    }
    if (fixture.action === 'pause-all' || fixture.action === 'resume-all') {
      const paused = fixture.action === 'pause-all'
      const hold = repositoryDelta.find((event) => event.type === 'dispatcher.pause-set')!
      const intake = repositoryDelta.find((event) => event.type === 'dispatcher.intake-set')!
      assert.equal(hold.payload.enabled, paused, `${label}: repository hold`)
      assert.equal(intake.payload.enabled, !paused, `${label}: intake follows hold`)
    }
    if (fixture.action === 'review-round-ceiling') {
      const answer = buildDelta.find((event) => event.type === 'escalation.answered')!
      assert.equal(answer.payload.reviewRoundCeiling, 5)
    }
    if (fixture.action === 'revise-body' || fixture.action === 'revise-ticket') {
      const revision = buildDelta.find((e) => e.type === 'spec.revised')!
      if (revision.type !== 'spec.revised') throw Error('Missing typed spec revision')
      const artifact = await store.getArtifact(
        fixture.build,
        revision.payload.artifact.kind,
        revision.payload.artifact.rev,
      )
      assert.ok(artifact, `${label}: replacement body exists`)
      assert.equal(
        Buffer.from(artifact.content).toString('utf8'),
        fixture.text,
        `${label}: exact replacement bytes`,
      )
      if (fixture.action === 'revise-ticket')
        assert.deepEqual(revision.payload.assets, [], `${label}: empty ticket assets repinned`)
    }
    if (fixture.mode === 'js') {
      let acknowledged = false
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await driver.evaluate(`Boolean(document.querySelector('[data-control-notice]'))`)) {
          acknowledged = true
          break
        }
        await Bun.sleep(30)
      }
      assert.ok(acknowledged, `${label}: enhanced acknowledgment missing`)
      assert.equal(
        await driver.evaluate('window.__extendedDocument===document'),
        true,
        `${label}: full reload`,
      )
      if (fixture.action === 'intake') {
        const enabled = !repositoryDelta.find((event) => event.type === 'dispatcher.intake-set')!
          .payload.enabled
        await store.appendRepo(fixture.project, {
          actor: { kind: 'human', user: 'other@example.com' },
          type: 'dispatcher.intake-set',
          payload: { enabled },
        })
        let refreshed = false
        for (let attempt = 0; attempt < 150; attempt++) {
          refreshed = Boolean(
            await driver.evaluate(
              `document.querySelector('button[value="intake"]')?.textContent.trim()===${JSON.stringify(`Intake ${enabled ? 'ON' : 'OFF'}`)} && !document.querySelector('[data-control-notice]')`,
            ),
          )
          if (refreshed) break
          await Bun.sleep(40)
        }
        assert.ok(refreshed, `${label}: acknowledgment froze repository controls`)
        assert.equal(await driver.evaluate('window.__extendedDocument===document'), true)
      }
    }
    evidence.push({
      mode: fixture.mode,
      action: fixture.action,
      buildEvents: buildDelta.map((e) => e.type),
      repositoryEvents: repositoryDelta.map((e) => e.type),
      identity: 'operator@example.com',
    })
  }
  await driver.scripts(true)
  return evidence
}
