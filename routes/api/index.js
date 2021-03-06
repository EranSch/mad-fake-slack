const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');

const { dbManager, wsManager } = require('../managers');
const responses = require('../responses');
const utils = require('./utils');
const factories = require('./factories');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, '/tmp/uploads');
  },
  filename: (req, file, cb) => {
    cb(null, `${file.fieldname}-${Date.now()}`);
  }
});

const upload = multer({ storage });

function beforeAllHandler(req, res, next) {
  if (utils.isUrlEncodedForm(req)) {
    express.urlencoded()(req, res, next);
  } else if (utils.isMultipartForm(req)) {
    upload.none()(req, res, next);
  } else {
    express.json()(req, res, next);
  }
}

function authTestHandler(req, res) {
  const token = (req.body && req.body.token) || req.headers.Authorization || req.headers.authorization;
  if (!token) {
    res.json(responses.invalid_auth);
    return;
  }

  const uid = crypto
    .createHash('md5')
    .update(token)
    .digest('hex');

  const users = dbManager.users().findById(dbManager.db.sessions[uid]);
  if (!users.length) {
    res.json(responses.invalid_auth);
  } else {
    const user = users[0];
    const team = dbManager.db.teams.filter(tm => tm.id === user.team_id)[0];
    const exampleResponse = responses['auth.test'];
    exampleResponse.team_id = team.id;
    exampleResponse.user_id = user.id;
    const schema = process.env.URL_SCHEMA || 'http';
    exampleResponse.url = `${schema}://${team.domain}/`;
    exampleResponse.team = team.name || exampleResponse.team;
    exampleResponse.user = user.name || exampleResponse.team;
    res.json(exampleResponse);
  }
}

function createResponse({
  user,
  team,
  ...other
}) {
  return factories.createMessageResponse(
    {
      type: 'message',
      ...other
    },
    { user, team }
  );
}

function broadcastResponse({ payload, channel, userId }) {
  wsManager.broadcast(JSON.stringify(payload), userId);
  if (utils.isOpenChannel(channel)) {
    wsManager.broadcastToBots(JSON.stringify(payload), userId);
  }
  if (utils.isBot(channel, dbManager)) {
    wsManager.broadcastToBot(JSON.stringify(payload), channel);
  }
}

async function postMessageHandler(req, res) {
  const message = dbManager.channel(req.body.channel).createMessage(dbManager.slackUser().id, req.body);
  if (utils.isUrlEncodedForm(req) || utils.isMultipartForm(req)) {
    const channelId = utils.getChannelId(req.body.channel);
    res.redirect(`/messages/${channelId && channelId[0]}`);
  } else {
    const channel = utils.getChannelId(req.body.channel);
    const user = dbManager.slackUser();
    const team = dbManager.slackTeam();
    const response = createResponse({
      user,
      team,
      ts: message.ts,
      channel,
      text: req.body.text.trim(),
      hideHeader: message.hideHeader
    });
    broadcastResponse({ payload: response.message, userId: user.id, channel });
    res.json(response);
  }
}

function rtmConnectHandler(req, res) {
  const token = (req.body && req.body.token) || req.headers.Authorization;
  const tokenHash = crypto
    .createHash('md5')
    .update(token)
    .digest('hex');
  const successResponse = responses['rtm.connect'];

  const response = {
    ...successResponse
  };
  const { id: userId, name: userName } = dbManager.slackUser();
  response.self.id = userId;
  response.self.name = userName;

  const { id: teamId, domain, name: teamName } = dbManager.slackTeam();
  response.team.id = teamId;
  response.team.domain = domain;
  response.team.name = teamName;
  const schema = process.env.URL_SCHEMA || 'http';
  response.url = `${schema === 'http' ? 'ws' : 'wss'}://${domain}/ws?uid=${tokenHash}`;
  res.json(response);
}

function channelsListHandler(req, res) {
  const successResponse = {
    ...responses['channels.list']
  };

  successResponse.channels = dbManager.db.channels;
  res.json(successResponse);
}

function conversationsListHandler(req, res) {
  let { types } = req.query;
  const channelTypes = new Set();
  if (!types) {
    types = ['public_channel', 'private_channel'];
  }

  if (Array.isArray(types)) {
    types.forEach(type => channelTypes.add(type));
  } else {
    channelTypes.add(types);
  }

  res.json({ ok: true });
}

function userInfoHandler(req, res) {
  let { user: userId } = req.query;
  const users = dbManager.users().findById(userId);
  if (!users.length) {
    res.json(responses.user_not_found);
  } else {
    const user = users[0];
    const response = responses['users.info'];
    res.json({
      ...response,
      user
    });
  }
}

function chatUpdateHandler(req, res) {
  const { channel, ts, text } = req.body;
  const previousMessage = dbManager.channel(req.body.channel).findMessageByTs(ts);
  const user = dbManager.slackUser();
  const team = dbManager.db.teams.filter(tm => tm.id === user.team_id)[0];

  if (!previousMessage || previousMessage.user_id !== user.id || !text) {
    res.json(responses.cant_update_message);
    return;
  }

  const message = dbManager.channel(req.body.channel).updateMessage({
    ...previousMessage,
    text
  });

  const payload = factories.createUpdateMessageEvent({
    channel,
    message,
    previousMessage
  }, { user, team });

  broadcastResponse({ payload, userId: user.id, channel });

  res.json({
    ok: true,
    channel,
    ts,
    text
  });
}

router.use('*', beforeAllHandler);

router.post('/auth.test', authTestHandler);
router.post('/chat.postMessage', postMessageHandler);
router.post('/channels.list', channelsListHandler);
router.post('/rtm.connect', rtmConnectHandler);
router.post('/rtm.start', rtmConnectHandler);
router.post('/chat.update', chatUpdateHandler);

router.get('/rtm.connect', rtmConnectHandler);
router.get('/rtm.start', rtmConnectHandler);
router.get('/users.info', userInfoHandler);
router.get('/conversations.list', conversationsListHandler);

module.exports = router;
