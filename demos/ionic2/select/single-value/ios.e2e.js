describe('select/single-value: ios', function() {

it('should init', function() {
  browser.get('http://localhost:8876/dist/e2e/select/single-value/index.html?ionicplatform=ios&ionicOverlayCreatedDiff=0&ionicanimate=false&snapshot=true');
});

"use strict";
it('should open gender single select', function () {
    element(by.css('.e2eSelectGender button')).click();
});

});