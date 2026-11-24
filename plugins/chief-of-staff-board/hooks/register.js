import { atom, read, update } from 'claude-code';
import { EMPTY, STARTER, boardPath, cut, isOpenable, openArgv, parseBoard, setupPrompt, slackAppLink } from './board.ts';
// A side pane for a coordinator ("chief of staff") session. The coordinator
// agent keeps one JSON file of what needs the person; this draws that file and
// never writes it, apart from the starter file /board-setup makes.
const PANE = 'chief-of-staff-board';
const board = atom({ plugin: 'chief-of-staff-board', key: 'board' }, EMPTY, { shape: 'board-1' });
const raw = atom({ plugin: 'chief-of-staff-board', key: 'raw' }, '', { shape: 'raw-1' });
// Re-read the file; redraw only when its text changed.
async function load($, file) {
    if (!file)
        return;
    let text = '';
    try {
        text = await $.fs.read(file);
    }
    catch {
        return;
    }
    if (text === (await read($, raw)))
        return;
    const parsed = parseBoard(text);
    if (!parsed)
        return; // a half-written file: keep the last good board
    await update($, board, () => parsed);
    await update($, raw, () => text);
}
export const register = (on, options) => {
    const team = typeof options.slackTeamId === 'string' ? options.slackTeamId.trim() : '';
    const seconds = Number(options.pollSeconds);
    const pollMs = (Number.isFinite(seconds) && seconds >= 1 ? seconds : 5) * 1000;
    // Set at session.start; the command and the pane read it.
    let file = '';
    let platform;
    on('session.start', async ($, e, next) => {
        const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
        file = boardPath(options.boardFile, e.cwd, home);
        platform = (await $.session.info()).platform;
        await $.command.register({ name: 'board', description: "Show the chief-of-staff board: what is waiting on you" });
        await $.command.register({ name: 'board-setup', description: 'Create the board file and brief this session as your chief of staff' });
        // No person at the prompt (-p, SDK): the commands exist, nothing is drawn or polled.
        if (e.isInteractive === false)
            return next(e);
        await load($, file);
        $.clock.every(pollMs, () => void load($, file));
        // Open by itself only where there is a board to show.
        if (await $.fs.exists(file))
            void $.ui.open({ id: PANE, title: 'Board' });
        return next(e);
    });
    on('command.run', { command: 'board' }, async ($) => {
        await load($, file);
        await $.ui.open({ id: PANE, title: 'Board' });
        return { text: (await $.fs.exists(file)) ? 'Board opened.' : `No board file at ${file} yet. Run /board-setup.` };
    });
    on('command.run', { command: 'board-setup' }, async ($) => {
        const made = !(await $.fs.exists(file));
        if (made)
            await $.fs.write(file, STARTER);
        await load($, file);
        await $.ui.open({ id: PANE, title: 'Board' });
        await $.prompt.fill({ text: setupPrompt(file), mode: 'replace' });
        return { text: `${made ? 'Created' : 'Kept'} ${file}. The setup prompt is in the box: read it, change what you like, and send it.` };
    });
    on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
        const { Box, Text, Button } = $.ui.resolve(e);
        const b = await read($, board);
        const cols = Math.max(24, e.props.bodyColumns ?? 40);
        const group = (title, color, items, opts) => (<Box flexDirection="column" marginTop={1}>
        <Text bold color={color}>
          {title} · {items.length}
        </Text>
        {items.length === 0 && <Text dimColor> nothing</Text>}
        {items.slice(0, opts.max).map(it => (<Box flexDirection="column" key={`${title}-${it.id}-${it.title}`}>
            <Text dimColor={opts.dim} wrap="wrap">
              {it.id ? <Text bold>{it.id} </Text> : ''}
              {it.title}
            </Text>
            {it.note && !opts.dim && (<Text dimColor wrap="wrap">
                {'  '}
                {cut(it.note, cols * 2 - 4)}
              </Text>)}
            <Box flexDirection="row" gap={1}>
              {it.link && isOpenable(it.link) && (<Button key={`open:${title}:${it.id}:${it.title}`} label={`Open ${cut(it.linkLabel ?? 'link', 18)}`} onPress={() => void $.process.run(openArgv(platform, slackAppLink(it.link, team)))}/>)}
              {opts.buttons && (<Button key={`reply:${title}:${it.id}:${it.title}`} label="Answer" onPress={() => void $.prompt.fill({ text: `Board ${it.id || it.title}: `, mode: 'replace' })}/>)}
            </Box>
          </Box>))}
        {items.length > opts.max && <Text dimColor> +{items.length - opts.max} more</Text>}
      </Box>);
        return (<Box flexDirection="column">
        <Text dimColor>{b.updated ? `updated ${b.updated}` : 'no board yet: run /board-setup'}</Text>
        {group('WAITING ON YOU', 'yellow', b.waiting, { buttons: true, max: 12 })}
        {group('READY FOR REVIEW', 'cyan', b.review, { buttons: true, max: 5 })}
        {group('WORKING', 'magenta', b.working, { max: 6 })}
        {group('HANDLED FOR YOU', 'green', b.handled, { dim: true, max: 6 })}
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">Open goes to the thread or PR. Answer starts a reply to your coordinator.</Text>
        </Box>
      </Box>);
    });
};
