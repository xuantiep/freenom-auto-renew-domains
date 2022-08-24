const puppeteerOpts = require('./config/puppeteer').options
const puppeteer = require('puppeteer')
const util = require('util')
const discord = require('./connectors/discord')
const sqlite3 = require('sqlite3').verbose()
const fs = require('fs')

const cookiesPath = 'data/cookies'

const renewDomains = async (message) => {
  await freenom.page.goto(domain.renewLink, { waitUntil: 'networkidle2' })
  await freenom.page.waitForSelector('.renewDomains')
  await freenom.page.evaluate(() => document.getElementsByTagName('option')[11].selected = true)
  await freenom.page.evaluate(() => document.getElementsByTagName('form')[0].submit())
  await freenom.page.waitForSelector('.completedOrder').catch(async () => {
    message += `**[${domain.name}]** An error has occurred while trying to auto renew this domain`
  })
  message += `**[${domain.name}]** Auto renewal complete !`

  return message
}

const freenom = {
  browser: null,
  page: null,
  logged: false,
  url: 'https://my.freenom.com/domains.php?a=renewals',
  db: new sqlite3.Database(`./${process.env.DB_NAME}.db`,
    sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
      if (err) console.error(err.message)
      console.log(`Connected to the ${process.env.DB_NAME} database.`)

      freenom.db.run(`CREATE TABLE IF NOT EXISTS freenom(
        id text not null,
        name text not null primary key,
        free tinyint not null,
        autoRenew tinyint not null,
        status text not null
      )`)
    }),
  getDbDomain: async (name) => await freenom.db.get('SELECT * FROM freenom WHERE name = ?', [name]),
  close: async () => {
    if (!freenom.browser) return true
    await freenom.browser.close().then(async () => {
      freenom.browser = null
      console.log(`Scrap finished for ${freenom.url}`)
    })
  },
  init: async () => {
    try {
      freenom.browser = await puppeteer.launch(puppeteerOpts)
      freenom.page = await freenom.browser.newPage()
      await freenom.page.setViewport({ width: 1900, height: 1000, deviceScaleFactor: 1 })

      await freenom.page.goto(freenom.url, { waitUntil: 'networkidle2' })

      const title = await freenom.page.title()
      console.log(title)

      freenom.db.run = util.promisify(freenom.db.run)
      freenom.db.get = util.promisify(freenom.db.get)
      freenom.db.all = util.promisify(freenom.db.all)

      const hasPreviousSession = await freenom.previousSession()
      if (!hasPreviousSession) await freenom.login()

      await freenom.renewFreeDomains()
    } catch (e) {
      console.error('[INIT] Failed', e)
    } finally {
      await freenom.close()
    }
  },
  previousSession: async () => {
    const previousSession = fs.existsSync(cookiesPath)
    if (previousSession) {
      const content = fs.readFileSync(cookiesPath)
      const cookies = JSON.parse(content || '[]')
      if (cookies.length > 0) {
        for (let cookie of cookies) await CMC.page.setCookie(cookie)
        console.log('Session has been loaded in the browser')
        return true
      }
    }

    return false
  },
  updateSession: async () => {
    const cookiesObject = await CMC.page.cookies()
    fs.writeFileSync(cookiesPath, JSON.stringify(cookiesObject))
    console.log('Session has been saved to ' + cookiesPath)
  },
  login: async () => {
    try {
      await freenom.page
        .type('input[name="username"]', process.env.FREENOM_LOGIN, { delay: 35 })
        .then(async () => console.log('Username complete'))
      await freenom.page.waitForTimeout(500)
      await freenom.page
        .type('input[name="password"]', process.env.FREENOM_PASS, { delay: 35 })
        .then(async () => console.log('Password complete'))
      await freenom.page.evaluate(() => document.getElementsByTagName('form')[0].submit())
      await freenom.page.waitForSelector('.renewalContent').catch(e => {
        throw new Error(`Login Details Incorrect. Please check your .env file. (${e.message})`)
      })
      console.log('connected')
      freenom.logged = true
    } catch (e) {
      console.error('[login]', e)
      await freenom.close()
    }
  },
  renewFreeDomains: async () => {
    try {
      const domains = await freenom.page.evaluate(() => {
        let domains = []
        for (let i = 0; i < document.getElementsByTagName('tbody')[0].children.length; i++) {
          domains.push({
            name: document.getElementsByTagName('tbody')[0].children[i].childNodes[0].innerText,
            status: document.getElementsByTagName('tbody')[0].children[i].childNodes[1].innerText,
            expires: document.getElementsByTagName('tbody')[0].children[i].childNodes[2].innerText,
            renewable: document.getElementsByTagName('tbody')[0].children[i].childNodes[3].innerText === 'Renewable',
            renewLink: document.getElementsByTagName('tbody')[0].children[i].childNodes[5].childNodes[0].href,
          })
        }

        return domains
      })

      let message = ``
      let messages = []
      let i = 1
      await Promise.all(domains.map(async domain => {
        const id = domain.renewLink.replace('https://my.freenom.com/domains.php?a=renewdomain&domain=', '')
        const daysLeft = parseInt(domain.expires.replace(' Days', ''))
        // this condition may return false positive, due to lake of data on freenom,
        // the false positive can occurs in the case where a free domain in renewable,
        // that's why the scrapper should be run a first time without any free domains renewables
        // (in this way the free domain state will be saved in db)
        const freeDomain = (daysLeft > 14 && domain.renewable === false)
        let row = await freenom.getDbDomain(domain.name)

        if (row === undefined) {
          await freenom.db.run(`INSERT INTO freenom
          (id, name, status, free, autoRenew) VALUES(?, ?, ?, ?, ?)`,
            [id, domain.name, domain.status, freeDomain, !!freeDomain],
          )
          row = await freenom.getDbDomain(domain.name)
        }

        message += `- **${domain.name}** _(${row.free ? 'free' : 'paid'})_: **${daysLeft}** days left.\n  Auto renewal is ${row.autoRenew === 1 ? '**enabled**.' : '**disabled**.'} ${daysLeft < 14 && row.free && row.autoRenew ? 'Starting auto renewal.' : ''}\n\n`

        if (daysLeft < 14 && row.free && row.autoRenew) message = await renewDomains()
        messages.push(message)
        message = ''

        if (i === domains.length) {
          const message = messages.join().replace(/,-/g, '-')
          console.log('message: ', message)
          if (message.length <= 2000 && i < 8) await discord(message)
          else {
            let timer = 0
            await Promise.all(messages.map(async msg => {
              timer += 500
              setTimeout(async () => {
                console.log('message length > 2000', msg)
                await discord(msg)
              }, timer) // to avoid discord rate limited
            }))
          }
        }
        i += 1
      }))
    } catch (e) {
      console.error('[renew] Error', e)
      await freenom.close()
    }
  },
  renew: async (id) => {
    try {
      let message = ``

      freenom.page.goto(`https://my.freenom.com/domains.php?a=renewdomain&domain=${id}`, { waitUntil: 'networkidle2' })

      message = await renewDomains()
      await discord(message)
      return message
    } catch (e) {
      console.error('[renew] Error', e)
      await freenom.close()
    }
  },
}

module.exports = freenom
