process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://a549306c82814cb8a1118c1695718eee:ed5e5794595a4182acf408de4e088037@sentry.cozycloud.cc/37'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  signin,
  scrape,
  saveBills,
  htmlToPDF
} = require('cozy-konnector-libs')
const sleep = require('util').promisify(global.setTimeout)

// cheerio & moment are dependencies from cozy-konnect-libs
const moment = require('moment')
const pdf = require('pdfjs')

const DEBUG = false
const baseUrl = 'https://secure.booking.com/'

const necessaryHeaders = {
  Referer: baseUrl,
  Accept: 'text/html',
  'Accept-Language': 'en'
}

let request = requestFactory()
const j = request.jar()
request = requestFactory({
  debug: DEBUG,
  cheerio: true,
  jar: j,
  headers: necessaryHeaders
})

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticateWithRetry(fields.login, fields.password)
  log('info', 'Authenticated')
  const $ = await request(`${baseUrl}myreservations.html`)
  log('info', 'Parsing ...')
  const items = await parseBookings($)
  const oldItems = await parseOldBooking($)
  items.push.apply(items, oldItems)
  log('info', `Got ${items.length} bookings, building PDFs ...`)
  const files = (await Promise.all(items.map(toFileEntry))).filter(Boolean)
  log('info', 'Saving PDFs ...')
  await saveBills(files, fields, {
    contentType: 'application/pdf',
    identifiers: ['booking.com']
  })
}

async function resetCookies() {
  return new Promise(resolve => {
    j._jar.store.removeCookies('booking.com', '/', err => {
      if (err) log('error', err.message)
      resolve()
    })
  })
}

async function authenticateWithRetry(username, password) {
  const NB_RETRY = 10
  const RETRY_STEP_S = 5
  const noRetryErrors = [
    errors.LOGIN_FAILED,
    errors.USER_ACTION_NEEDED.CHANGE_PASSWORD
  ]
  let lastError = false

  for (let i = 0; i < NB_RETRY; i++) {
    try {
      log('info', `try ${i}`)
      await resetCookies()
      await authenticate(username, password)
      lastError = false
      break
    } catch (err) {
      log('info', err.message)
      lastError = err.message
      if (noRetryErrors.includes(lastError)) break
      await sleep(RETRY_STEP_S * 1000)
    }
  }

  if (lastError) throw new Error(lastError)
}

async function authenticate(username, password) {
  await signin({
    debug: DEBUG,
    url: `${baseUrl}myreservations.html`,
    requestInstance: request,
    formSelector: '.js-user-access-form--signin',
    formData: { username, password },
    headers: necessaryHeaders,
    validate: (statusCode, $) => {
      if (statusCode !== 200) {
        log('error', `VENDOR_DOWN status is not 200 : ${statusCode}`)
        throw new Error(errors.VENDOR_DOWN)
      }
      const redirect = $.html()
        .split('\n')
        .find(line => line.includes('document.location.href'))
      const matches = redirect.match(/has_error=(.*)&has_error_action/)
      log('info', 'error matching')
      log('info', JSON.stringify(matches))

      if (
        matches &&
        ['wrong_password', 'wrong_username'].includes(matches[1])
      ) {
        return false
      }

      if (matches && matches[1] === '0') {
        return true
      }

      if (matches && ['too_many_tries'].includes(matches[1])) {
        throw new Error(errors.USER_ACTION_NEEDED.CHANGE_PASSWORD)
      }

      if (matches) {
        log('error', `Unknown error message ${matches[1]}`)
        throw new Error(errors.VENDOR_DOWN)
      } else {
        log('error', `no redirect`)
        throw new Error(errors.VENDOR_DOWN)
      }
    }
  })
}

function parseDateBlock(node) {
  const day = node
    .find('.mb-dates__day')
    .text()
    .trim()
  const monthAndYear = node
    .find('.mb-dates__month')
    .text()
    .trim()
  return moment(`${day} ${monthAndYear}`, 'DD MMM YYYY')
}

async function parseBookings($) {
  return scrape(
    $,
    {
      name: {
        sel: '.mb-block__hotel-name a',
        fn: node => node.text().trim()
      },
      picture: {
        sel: '.mb-block__photo img',
        fn: node => node.attr('src')
      },
      start: {
        sel: '.mb-dates__block.floatLeft',
        fn: parseDateBlock
      },
      end: {
        sel: '.mb-dates__block.floatRight',
        fn: parseDateBlock
      },
      bookingNb: {
        sel: '.mb-block__book-number b.marginRight_5',
        fn: node => node.text().trim()
      },
      price: {
        sel: '.mb-block__price .mb-block__price__big',
        fn: node => node.text().trim()
      },
      seeBookingUrl: {
        sel: '.mb-block__actions .res-actions__item-link',
        fn: node => {
          if (node.text().includes('Rate')) {
            return false
          }
          return node.attr('href')
        }
      }
    },
    '.js-booking_block'
  )
}

async function parseOldBooking($) {
  return scrape(
    $,
    {
      name: {
        sel: '.mb-hotel-name a',
        fn: node => node.text().trim()
      },
      picture: {
        sel: '.mb-block__photo img',
        fn: node => node.attr('src')
      },
      start: {
        sel: '.mh-date',
        fn: elems =>
          moment(
            $(elems[0])
              .text()
              .trim()
              .split(',')
              .pop()
              .trim(),
            'D MMMM YYYY'
          )
      },
      end: {
        sel: '.mh-date',
        fn: elems =>
          moment(
            $(elems[1])
              .text()
              .trim()
              .split(',')
              .pop()
              .trim(),
            'D MMMM YYYY'
          )
      },
      bookingNb: {
        sel: '.mb-block__book-number b.marginRight_5',
        fn: node => node.text().trim()
      },
      price: {
        sel: '.mb-price__unit',
        fn: node =>
          node
            .text()
            .split(' ')
            .pop()
            .trim()
      },
      seeBookingUrl: {
        sel: '.mb-block__actions .res-actions__item-link',
        fn: node => {
          if (node.text().includes('Rate')) {
            return false
          }
          return node.attr('href')
        }
      }
    },
    '.mb-container'
  )
}

async function toFileEntry(item) {
  const pdf = item.end.isAfter(new Date())
    ? await makeConfirmationPDF(item)
    : await makeOldBookingPDF(item)

  const amount = parseFloat(
    item.price
      .split(' ')
      .pop()
      .replace(',', '.')
  )
  const date = item.start.toDate()
  if (!amount || !date) return false

  return {
    filename: item.start.format('YYYY-MM-DD') + '-' + item.name + '.pdf',
    filestream: pdf._doc,
    vendor: 'booking.com',
    date,
    amount
  }
}

const helveticaFont = require('pdfjs/font/Helvetica')
const helveticaBoldFont = require('pdfjs/font/Helvetica-Bold')

function makeCell(doc, text) {
  return doc
    .cell({ paddingBottom: 0.5 * pdf.cm })
    .text()
    .add(text, { font: helveticaBoldFont, fontSize: 14 })
}

function makeRow(table, ...texts) {
  const row = table.row()
  for (let text of texts) row.cell(text, { padding: 5 })
}

async function makeOldBookingPDF(item) {
  var doc = new pdf.Document({ font: helveticaFont })
  makeCell(doc, 'Booking.com Réservation ' + item.bookingNb)
  makeCell(
    doc,
    'Généré automatiquement par le connecteur booking.com depuis la page '
  ).add(`${baseUrl}/myreservations.html`, {
    link: `${baseUrl}/myreservations.html`,
    color: '0x0000FF'
  })
  makeCell(doc, item.name)
  const table = doc.table({
    widths: ['*', '*'],
    borderWidth: 1
  })
  makeRow(table, 'Réservation #', item.bookingNb)
  makeRow(table, 'Price', item.price)
  makeRow(table, 'Start', item.start.format('YYYY-MM-DD'))
  makeRow(table, 'End', item.end.format('YYYY-MM-DD'))
  doc.end()
  return doc
}

async function makeConfirmationPDF(item) {
  if (!item.seeBookingUrl) return false

  log('info', 'in makeConfirmationPDF')
  log('info', item)
  let bookingPage$ = await request(`${baseUrl}${item.seeBookingUrl}`)
  const confirmationURL = bookingPage$('.view_conf').attr('href')
  if (!confirmationURL) return false
  let $ = await request(`${baseUrl}${confirmationURL}`)
  var doc = new pdf.Document({ font: helveticaFont })
  makeCell(doc, 'Booking.com Confirmation #' + item.bookingNb)
  makeCell(
    doc,
    'Généré automatiquement par le connecteur booking.com depuis la page'
  ).text(`${baseUrl}${item.seeBookingUrl}`, {
    link: `${baseUrl}${item.seeBookingUrl}`,
    color: '0x0000FF'
  })

  $(
    '#column_holder .section' +
      ':not(.bankcard_wrapper)' +
      ':not(.conf-faq)' +
      ':not(#xsell_conf_cyt)' +
      ':not(.newsletter_selection)' +
      ':not(#conf_send)'
  ).each((i, el) => {
    htmlToPDF($, doc, $(el), {
      baseURL: baseUrl,
      filter: $el => {
        return (
          !$el.hasClass('conf_spec_req') &&
          !$el.hasClass('conf_spec_req--success') &&
          !$el.hasClass('conf_spec_req--error') &&
          !$el.hasClass('conf-slidebox--checkin-time') &&
          !$el.hasClass('rt_resort_credits_info--policy') &&
          !$el.hasClass('join-banner') &&
          $el.attr('id') !== 'conf_send'
        )
      }
    })
  })
  doc.end()
  return doc
}
