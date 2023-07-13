import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('bookingdotcomCCC')

const baseUrl = 'https://booking.com'

class TemplateContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.runInWorker(
      'click',
      'a[data-testid="header-small-sign-in-button"]'
    )
    await this.waitForElementInWorker('#username')
  }

  // onWorkerEvent(event, payload) {
  //   if (event === 'loginSubmit') {
  //     this.log('info', 'received loginSubmit, blocking user interactions')
  //     this.blockWorkerInteractions()
  //   } else if (event === 'loginError') {
  //     this.log(
  //       'info',
  //       'received loginError, unblocking user interactions: ' + payload?.msg
  //     )
  //     this.unblockWorkerInteractions()
  //   }
  // }

  async ensureAuthenticated({ account }) {
    // this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    this.log('info', '🤖 ensureAuthenticated')
    // if (!account) {
    //   await this.ensureNotAuthenticated()
    // }
    await this.goto(baseUrl)
    await Promise.race([
      this.waitForElementInWorker(
        'a[data-testid="header-small-sign-in-button"]'
      ),
      this.waitForElementInWorker('button[data-testid="header-profile"]')
    ])
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      await this.navigateToLoginForm()
      await this.showLoginFormAndWaitForAuthentication()
    }
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
    return true
  }

  // onWorkerReady() {
  //   const button = document.querySelector('input[type=submit]')
  //   if (button) {
  //     button.addEventListener('click', () =>
  //       this.bridge.emit('workerEvent', 'loginSubmit')
  //     )
  //   }
  //   const error = document.querySelector('.error')
  //   if (error) {
  //     this.bridge.emit('workerEvent', 'loginError', { msg: error.innerHTML })
  //   }
  // }

  async checkAuthenticated() {
    const passwordField = document.querySelector('#password')
    const loginField = document.querySelector('#username')
    if (loginField || passwordField) {
      const field = loginField ? loginField : passwordField
      const type = loginField ? 'email' : 'password'
      await this.findAndSendCredentials.bind(this)(field, type)
    }
    return Boolean(
      document.querySelector('button[data-testid="header-profile"]')
    )
  }

  async findAndSendCredentials(field, type) {
    this.log('info', 'findAndSendCredentials starts')
    let foundCredential = field.value
    this.log('info', `foundCred : ${foundCredential}`)
    this.log('info', "Sending user's credentials to Pilot")
    await this.sendToPilot({
      [type]: foundCredential
    })
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    await this.clickAndWait(
      'button[data-testid="header-profile"]',
      'a[href*="https://secure.booking.com/mysettings"]'
    )
    await this.clickAndWait(
      'a[href*="https://secure.booking.com/mysettings"]',
      'a[data-test-id="mysettings-nav-link-personal_details"]'
    )
    await this.runInWorker(
      'click',
      'a[data-test-id="mysettings-nav-link-personal_details"]'
    )
    await Promise.all([
      this.waitForElementInWorker('div[data-test-id="mysettings-row-name"]'),
      this.waitForElementInWorker('div[data-test-id="mysettings-row-email"]'),
      this.waitForElementInWorker('div[data-test-id="mysettings-row-phone"]'),
      this.waitForElementInWorker('div[data-test-id="mysettings-row-address"]')
    ])
    const userIdentity = await this.runInWorker('getIdentity')
    await this.saveIdentity(userIdentity)
    await this.waitForElementInWorker('[pause]')
    if (this.store.email) {
      return {
        sourceAccountIdentifier: this.store.email
      }
    } else {
      throw new Error('No user data identifier, The konnector should be fixed')
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    if (this.store && this.store.email && this.store.password) {
      const userCredentials = {
        email: this.store.email,
        password: this.store.password
      }
      await this.saveCredentials(userCredentials)
    }

    // There is no bills generate by the website, we need to convert the HTML to PDF so we can save it on the cozy.
  }

  async getIdentity() {
    this.log('info', 'getIdentity starts')
    let elementsArray = []
    let foundInfos = []
    const cards = document.querySelectorAll('div[class="settings-row"]')
    for (const card of cards) {
      let title = card.querySelector('h2[id*="_title"]').textContent
      if (
        title === 'Nom' ||
        title === 'Adresse e-mail' ||
        title === 'Numéro de téléphone' ||
        title === 'Adresse'
      ) {
        elementsArray.push(card)
      }
    }
    for (const element of elementsArray) {
      const infoElement = element.querySelector(
        'div[id*="_content"] > div'
      )?.textContent
      const cleanElement = infoElement.replace('Vérifiée', '')
      foundInfos.push(cleanElement)
    }
    const [formattedName, email, phone, address] = foundInfos
    let userIdentity = {}
    if (formattedName) {
      const [givenName, familyName] = formattedName.split(' ')
      userIdentity.name = {
        givenName,
        familyName,
        formattedName
      }
    }
    if (email) {
      userIdentity.email = email
    }
    if (phone) {
      // Here the only way to register a pĥone on the website is to have an SMS sent to the given number
      // So it must be a mobile phone
      userIdentity.phone = [
        {
          number: phone,
          type: 'mobile'
        }
      ]
    }
    if (address) {
      userIdentity.address = {
        formattedAddress: address.replace(/,/g, ' ')
      }
    }
    return userIdentity
  }
}

const connector = new TemplateContentScript()
connector
  .init({ additionalExposedMethodsNames: ['getIdentity'] })
  .catch(err => {
    log.warn(err)
  })
